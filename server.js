import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {}; // { roomCode: { host, players, settings, started } }

function broadcastRoomList() {
  const list = Object.entries(rooms).map(([code, data]) => ({
    code,
    host:
      data.players.find((p) => p.id === data.host && p.status === "online")?.name ||
      "Ẩn danh",
    playerCount: data.players.filter((p) => p.status === "online").length,
    started: data.started,
  }));
  io.emit("room_list_update", list);
}

function getRoom(roomCode) {
  return rooms[roomCode];
}

function updatePlayers(roomCode) {
  const room = getRoom(roomCode);
  if (!room) return;
  io.to(roomCode).emit("players_update", room.players);
}

io.on("connection", (socket) => {
  console.log("🟢", socket.id, "connected");

  socket.on("create_room", ({ roomCode, hostName, userId }) => {
    rooms[roomCode] = {
      host: userId,
      players: [
        { id: userId, socketId: socket.id, name: hostName, role: "host", status: "online", keyword: null },
      ],
      settings: {
        villagers: 3,
        spies: 1,
        whiteHats: 1,
        keywords: { villager: "", spy: "", whiteHat: "" },
      },
      started: false,
    };

    socket.join(roomCode);
    io.to(socket.id).emit("room_created", { roomCode, host: userId });
    updatePlayers(roomCode);
    broadcastRoomList();
  });

  socket.on("join_room", ({ roomCode, playerName, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return socket.emit("error_message", "Phòng không tồn tại!");

    const existing = room.players.find((p) => p.id === userId);
    if (existing) {
      existing.socketId = socket.id;
      existing.name = playerName || existing.name;
      existing.status = "online";
    } else {
      room.players.push({
        id: userId,
        socketId: socket.id,
        name: playerName,
        role: "player",
        keyword: null,
        status: "online",
      });
    }

    socket.join(roomCode);
    updatePlayers(roomCode);
    io.to(socket.id).emit("joined_success", { roomCode, host: room.host });
    broadcastRoomList();
  });

  socket.on("leave_room", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = room.players.find((p) => p.id === userId);
    if (!player) return;

    if (player.role === "host") {
      player.status = "offline";
      updatePlayers(roomCode);
    } else {
      room.players = room.players.filter((p) => p.id !== userId);
      socket.leave(roomCode);
      updatePlayers(roomCode);
    }

    broadcastRoomList();
  });

  socket.on("update_settings", ({ roomCode, userId, newSettings }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== userId) return;

    // Merge settings nested
    room.settings = {
      ...room.settings,
      ...newSettings,
      keywords: { ...room.settings.keywords, ...newSettings.keywords },
    };
    io.to(roomCode).emit("settings_updated", room.settings);
  });

  socket.on("start_game", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room || room.started || room.host !== userId) return;

    const totalRoles =
      room.settings.villagers + room.settings.spies + room.settings.whiteHats;
    const players = room.players.filter((p) => p.role !== "host");
    if (players.length < totalRoles) {
      return io.to(socket.id).emit(
        "error_message",
        "Không đủ người để bắt đầu game!"
      );
    }

    const shuffled = [...players].sort(() => Math.random() - 0.5);
    const assignedRoles = [
      ...shuffled
        .slice(0, room.settings.villagers)
        .map((p) => ({ id: p.id, role: "villager", keyword: room.settings.keywords.villager })),
      ...shuffled
        .slice(room.settings.villagers, room.settings.villagers + room.settings.spies)
        .map((p) => ({ id: p.id, role: "spy", keyword: room.settings.keywords.spy })),
      ...shuffled
        .slice(
          room.settings.villagers + room.settings.spies,
          totalRoles
        )
        .map((p) => ({ id: p.id, role: "whiteHat", keyword: room.settings.keywords.whiteHat }))
    ];

    // Update roles
    room.players = room.players.map((p) => {
      if (p.role === "host") return p;
      const assignment = assignedRoles.find((a) => a.id === p.id);
      return assignment ? { ...p, role: assignment.role, keyword: assignment.keyword } : p;
    });

    assignedRoles.forEach((p) => {
      const socketId = room.players.find((player) => player.id === p.id)?.socketId;
      if (socketId) io.to(socketId).emit("role_assigned", { role: p.role, keyword: p.keyword });
    });

    room.started = true;
    io.to(roomCode).emit("game_started");
  });

  socket.on("end_game", ({ roomCode }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const reveal = room.players
      .filter((p) => p.role !== "host")
      .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));
    io.to(roomCode).emit("game_ended", reveal);

    setTimeout(() => {
      room.started = false;
      room.players.forEach((p) => {
        if (p.role !== "host") {
          p.role = "player";
          p.keyword = null;
        }
      });
      updatePlayers(roomCode);
    }, 5000);
  });

  socket.on("get_player_info", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== userId) return;
    const reveal = room.players
      .filter((p) => p.role !== "host")
      .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));
    io.to(roomCode).emit("game_playing", reveal);
  });

  socket.on("disconnect", () => {
    for (const room of Object.values(rooms)) {
      const player = room.players.find((p) => p.socketId === socket.id);
      if (player) {
        player.status = "offline";
        player.socketId = null;
        updatePlayers(roomCode);
        console.log(`⚠️ ${player.name} bị disconnect`);
      }
    }
    broadcastRoomList();
  });

  socket.on("reconnect_room", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === userId);
    if (player) {
      player.socketId = socket.id;
      player.status = "online";
      socket.join(roomCode);
      updatePlayers(roomCode);

      // emit lại trạng thái
      if (player.role !== "player") {
        socket.emit("role_assigned", { role: player.role, keyword: player.keyword });
      }
      if (room.started) {
        const gameData = room.players
          .filter((p) => p.role !== "host")
          .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));
        socket.emit("game_playing", gameData);
      }

      io.to(socket.id).emit("reconnected_success");
    }
  });
});

app.get("/", (_, res) => res.send("✅ Server đang chạy"));
server.listen(process.env.PORT || 5008, () => console.log("🚀 Server chạy!"));
