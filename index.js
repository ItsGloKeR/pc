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

function startProxy() {
  const server = mc.createServer({
    "online-mode": false,
    host: config.host || "0.0.0.0",
    port: config.port || 25565,
    version: "1.8.9",
    motd: config.motd || "PhoenixClient Proxy",
    keepAlive: true,
  });

  server.on("playerJoin", async (client) => {
    console.log("Join: " + client.username + " (" + client.socket.remoteAddress + ")");

    client.write("login", {
      entityId: 0,
      gameMode: 0,
      dimension: 0,
      difficulty: 0,
      maxPlayers: 0,
      levelType: "normal",
      reducedDebugInfo: false,
    });

    if (client.socket) client.socket.setNoDelay(true);

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
          host: config.remote_host || "mc.hypixel.net",
          port: config.remote_port || 25565,
          version: "1.8.9",
          username: client.username,
          keepAlive: true,
          compression: true,
          auth(client, options) {
            client.username = options.username;
            options.session = {
              accessToken: token,
              selectedProfile: { id: uuid },
            };
            options.accessToken = options.session.accessToken;
            client.session = options.session;
            options.haveCredentials = true;
            client.emit("session", options.session);
            return options.connect(client);
          },
        });

        if (remote.socket) remote.socket.setNoDelay(true);

        let respawnSent = false;
        let lastPing = Date.now();
        let avgPing = 0;

        client.on("keep_alive", () => {
          const now = Date.now();
          const ping = now - lastPing;
          avgPing = avgPing ? avgPing * 0.8 + ping * 0.2 : ping;
          lastPing = now;
          console.log(`[Ping] ${client.username}: ${ping}ms (avg ${avgPing.toFixed(1)}ms)`);
        });

        function forwardPacket(sender, receiver, meta, data) {
          setImmediate(() => {
            if (receiver.state === mc.states.PLAY) receiver.write(meta.name, data);
          });
        }

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
              data.data.forEach((info) => {
                if (info.UUID === uuidDashes) info.UUID = client.uuid;
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
            canceled: false,
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
            for (const marker of markers) client.tasks.splice(marker, 1);
          } else if (packetMeta.name === "chat") {
            const data = client.deserializer.parsePacketBuffer(buffer).data.params;
            if (data.message.toLowerCase().startsWith("p.")) {
              const [command, ...args] = data.message.substring(2).split(" ");
              switch (command) {
                case "modules": {
                  chat.chat(client, "Modules: " + modules.map(m => m.name).map(m => (client.modules.some(inst => inst.constructor.name === m) ? "§a" : "§c") + m + "§r").join(", "));
                  break;
                }
                case "toggle":
                case "t": {
                  const enabledIndex = client.modules.findIndex(m => m.constructor.name.toLowerCase() === args[0]?.toLowerCase());
                  if (enabledIndex === -1) {
                    const mod = modules.find(m => m.name.toLowerCase() === args[0]?.toLowerCase());
                    if (mod) {
                      client.modules.push(new mod(client, remote));
                      chat.chat(client, "§aEnabled " + mod.name + "!");
                    } else chat.chat(client, "§cModule not found!");
                  } else {
                    chat.chat(client, "§cDisabled " + client.modules[enabledIndex].constructor.name + "!");
                    client.modules.splice(enabledIndex, 1);
                  }
                  break;
                }
                case "get": {
                  const mod = client.modules.find(m => m.constructor.name.toLowerCase() === args[0]?.toLowerCase());
                  if (!mod) {
                    chat.chat(client, "§cModule not found.");
                    break;
                  }
                  if (!mod.config) {
                    chat.chat(client, "§cModule has no config.");
                    break;
                  }
                  chat.chat(client, JSON.stringify(mod.config));
                  break;
                }
                case "set": {
                  const isPrimitive = v => v !== Object(v);
                  const resolvePath = (o, path, d) => path.split(".").reduce((p, k) => p ? p[k] : d, o);
                  const setPath = (o, path, v) => path.split(".").reduce((p, k, i) => p[k] = path.split(".").length === ++i ? v : p[k] || {}, o);
                  const value = JSON.parse(args[2] ?? null);
                  const mod = client.modules.find(m => m.constructor.name.toLowerCase() === args[0]?.toLowerCase());
                  if (!mod) {
                    chat.chat(client, "§cModule not found.");
                    break;
                  }
                  if (!mod.config) {
                    chat.chat(client, "§cModule has no config.");
                    break;
                  }
                  if (!isPrimitive(value)) {
                    chat.chat(client, "§cInvalid type.");
                    break;
                  }
                  if (typeof resolvePath(mod.config, args[1] ?? "") === typeof value) {
                    setPath(mod.config, args[1], value);
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
            canceled: false,
          };
          for (const module of client.modules) module.toServer(toServerEvent);
          if (toServerEvent.canceled) return;
          if (toServerEvent.modified) remote.write(toServerEvent.type, toServerEvent.data);
          else remote.writeRaw(buffer);
        });

        // Watchdog: reconnect if ping too high
        setInterval(() => {
          if (avgPing > 1000) {
            console.warn(`[!] High ping detected (${avgPing}ms). Restarting backend...`);
            remote.end("Restarting due to high ping");
            setTimeout(startProxy, 3000);
          }
        }, 10000);

        remote.on("end", (reason) => {
          console.log("Server disconnect: " + client.username + " (" + client.socket.remoteAddress + ")");
          client.end(reason);
        });
        client.on("end", (reason) => {
          console.log("Client disconnect: " + client.username + " (" + client.socket.remoteAddress + ")");
          remote.end(reason);
        });

        remote.on("error", console.error);
      }
    });

    client.on("error", console.error);
  });

  server.on("error", (err) => console.error("[Server Error]", err.message));
}

startProxy();
