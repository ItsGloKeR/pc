import fs from "fs/promises";
import mc from "minecraft-protocol";
import chat from "./utils/chat.js";
import config from "./config.json" with { type: "json" };

const modules = [];

for (const file of await fs.readdir("./modules")) {
	if (!file.endsWith(".js")) continue;
	modules.push((await import("./modules/" + file)).default);
	console.log("Loaded module " + file + "!");
}

const whitelist = [];

if (config.whitelist) {
	try {
		const lines = (await fs.readFile("./whitelist.txt", "utf8")).split("\n");
		for (const line of lines) {
			if (line) whitelist.push(line.toLowerCase().replaceAll("-", "").trim());
		}
	} catch {
		await fs.writeFile("./whitelist.txt", "", "utf8");
	}
	console.log("Whitelist loaded!");
}

const server = mc.createServer({
	"online-mode": false,
	host: config.host,
	port: config.port,
	version: "1.8.8",
	motd: config.motd
});

server.on("playerJoin", async client => {
	console.log("Join: " + client.username + " (" + client.socket.remoteAddress + ")");

	client.write("login", {
		entityId: 0,
		gameMode: 0,
		dimension: 0,
		difficulty: 0,
		maxPlayers: 0,
		levelType: "normal",
		reducedDebugInfo: false
	});

	client.socket.setNoDelay();

	client.modules = [];

	client.tasks = [];
	client.scheduleTask = (task, ticks = 0) => {
		client.tasks.push({ task, ticks });
	};

	chat.chat(client, "§cWarning: Do NOT authenticate if you don't trust this host.");
	chat.chat(client, "Please authenticate using phoenixclient-auth.");

	let authenticated = false;

	client.on("raw", (buffer, packetMeta) => {
		if (packetMeta.name !== "custom_payload") return;
		const data = client.deserializer.parsePacketBuffer(buffer).data.params;
		if (data.channel === "phoenixclient-auth") {
			if (authenticated) return;

			const [token, uuid] = data.data.toString("utf8").split(":").slice(1);
			if (!/[0-9a-f]+/.test(uuid)) {
				console.log("Auth fail (invalid uuid): " + client.username + " (" + client.socket.remoteAddress + ")");
				return;
			}
			const uuidDashes = uuid.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
			const uuidBytes = Buffer.from(uuid, "hex");

			if (config.whitelist && !whitelist.includes(uuid)) {
				console.log("Auth fail (whitelist): " + client.username + " (" + client.socket.remoteAddress + ")");
				return;
			}

			authenticated = true;
			chat.chat(client, "Authenticated!");
			console.log("Auth start: " + client.username + " (" + client.socket.remoteAddress + ")");

			const remote = mc.createClient({
				host: "mc.hypixel.net",
				port: 25565,
				version: "1.8.8",
				username: client.username,
				keepAlive: false,
				auth(client, options) {
					client.username = options.username
					options.session = {
						accessToken: token,
						selectedProfile: {
							id: uuid
						}
					};
					options.accessToken = options.session.accessToken;
					client.session = options.session;
					options.haveCredentials = true;
					client.emit("session", options.session);
					return options.connect(client);
				}
			});

			remote.on("state", state => {
				if (state !== "play") return;

				remote.socket.setNoDelay();

				let respawnSent = false;

				remote.on("raw", (buffer, packetMeta) => {
					if (packetMeta.state !== "play") return;
					if (packetMeta.name === "login") {
						if (!respawnSent) {
							const data = remote.deserializer.parsePacketBuffer(buffer).data.params;
							respawnSent = true;
							client.writeRaw(buffer);
							client.write("respawn", data);
							chat.chat(client, "Successfully transferred!");
							console.log("Auth complete: " + client.username + " (" + client.socket.remoteAddress + ")");
							return;
						}
					} else if (packetMeta.name === "player_info") {
						if (buffer.includes(uuidBytes)) {
							const data = remote.deserializer.parsePacketBuffer(buffer).data.params;
							data.data.forEach(data => {
								if (data.UUID === uuidDashes) data.UUID = client.uuid;
							});
							client.write("player_info", data);
							return;
						}
					}
					const toClientEvent = {
						type: packetMeta.name,
						get data() {
							return this._data ?? (this._data = remote.deserializer.parsePacketBuffer(buffer).data.params);
						},
						_data: null,
						raw: buffer,
						modified: false,
						canceled: false
					};
					for (const module of client.modules) module.toClient(toClientEvent);
					if (toClientEvent.canceled) return;
					if (toClientEvent.modified) client.write(toClientEvent.type, toClientEvent.data);
					else client.writeRaw(buffer);
				});

				client.on("raw", (buffer, packetMeta) => {
					if (packetMeta.state !== "play") return;
					if (["flying", "position", "look", "position_look"].includes(packetMeta.name)) {
						const markers = [];
						for (const [index, task] of Object.entries(client.tasks)) {
							if (task.ticks === 0) {
								task.task();
								markers.push(index);
								continue;
							}
							--task.ticks;
						}
						markers.reverse();
						for (const marker of markers) {
							client.tasks.splice(marker, 1);
						}
					} else if (packetMeta.name === "chat") {
						const data = client.deserializer.parsePacketBuffer(buffer).data.params;
						if (data.message.toLowerCase().startsWith("p.")) {
							const [command, ...args] = data.message.substring(2).split(" ");
							switch (command) {
								case "modules": {
									chat.chat(client, "Modules: " + modules.map(module => module.name).map(module => (client.modules.some(instance => instance.constructor.name === module) ? "§a" : "§c") + module + "§r").join(", "));
									break;
								}
								case "toggle":
								case "t": {
									const enabledIndex = client.modules.findIndex(module => module.constructor.name.toLowerCase() === args[0]?.toLowerCase());
									if (enabledIndex === -1) {
										const module = modules.find(module => module.name.toLowerCase() === args[0]?.toLowerCase());
										if (module) {
											client.modules.push(new module(client, remote));
											chat.chat(client, "§aEnabled " + module.name + "!");
										} else chat.chat(client, "§cModule not found!");
									} else {
										chat.chat(client, "§cDisabled " + client.modules[enabledIndex].constructor.name + "!");
										client.modules.splice(enabledIndex, 1);
									}
									break;
								}
								case "get": {
									const module = client.modules.find(module => module.constructor.name.toLowerCase() === args[0]?.toLowerCase());
									if (!module) {
										chat.chat(client, "§cModule not found.");
										break;
									}
									if (!module.config) {
										chat.chat(client, "§cModule has no config.");
										break;
									}
									chat.chat(client, JSON.stringify(module.config));
									break;
								}
								case "set": {
									const isPrimitive = value => value !== Object(value);
									const resolvePath = (object, path, defaultValue) => path.split(".").reduce((o, p) => o ? o[p] : defaultValue, object);
									const setPath = (object, path, value) => path.split(".").reduce((o, p, i) => o[p] = path.split(".").length === ++i ? value : o[p] || {}, object);
									const value = JSON.parse(args[2] ?? null);
									const module = client.modules.find(module => module.constructor.name.toLowerCase() === args[0]?.toLowerCase());
									if (!module) {
										chat.chat(client, "§cModule not found.");
										break;
									}
									if (!module.config) {
										chat.chat(client, "§cModule has no config.");
										break;
									}
									if (!isPrimitive(value)) {
										chat.chat(client, "§cInvalid type.");
										break;
									}
									if (typeof resolvePath(module.config, args[1] ?? "") === typeof value) {
										setPath(module.config, args[1], value);
										chat.chat(client, "§aSet " + args[1] + " to " + args[2] + "!");
									} else {
										chat.chat(client, "§cIncorrect type.");
									}
									break;
								}
								default: {
									chat.chat(client, "§cUnknown command.");
									break;
								}
							}
							return;
						}
					}
					const toServerEvent = {
						type: packetMeta.name,
						get data() {
							return this._data ?? (this._data = client.deserializer.parsePacketBuffer(buffer).data.params);
						},
						_data: null,
						raw: buffer,
						modified: false,
						canceled: false
					};
					for (const module of client.modules) module.toServer(toServerEvent);
					if (toServerEvent.canceled) return;
					if (toServerEvent.modified) remote.write(toServerEvent.type, toServerEvent.data);
					else remote.writeRaw(buffer);
				});
			});

			remote.on("end", reason => {
				console.log("Server disconnect: " + client.username + " (" + client.socket.remoteAddress + ")");
				client.end(reason);
			});
			client.on("end", reason => {
				console.log("Client disconnect: " + client.username + " (" + client.socket.remoteAddress + ")");
				remote.end(reason);
			});

			remote.on("error", console.error);
		}
	});
	
	client.on("error", console.error);
});

server.on("errorr", console.error);
