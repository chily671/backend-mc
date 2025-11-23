import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = {}; // { roomCode: { host, players, settings, started } }

let lastRoomList = null;

function broadcastRoomList() {
  const list = Object.entries(rooms).map(([code, data]) => ({
    code,
    host: data.players.find((p) => p.id === data.host)?.name || "Ẩn danh",
    playerCount: data.players.length,
    started: data.started,
  }));

  const json = JSON.stringify(list);

  if (json !== lastRoomList) {
    // chỉ emit khi thay đổi
    lastRoomList = json;
    io.emit("room_list_update", list);
  }
}

function getRoom(roomCode) {
  return rooms[roomCode];
}

const playerCache = {}; // { roomCode: "json-string" }

function updatePlayers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const payload = room.players.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    role: p.role,
  }));

  const json = JSON.stringify(payload);

  if (playerCache[roomCode] !== json) {
    playerCache[roomCode] = json;
    io.to(roomCode).emit("players_update", room.players);
  }
}

io.on("connection", (socket) => {
  console.log("🟢", socket.id, "connected");

  socket.on("ping_check", () => socket.emit("pong"));
  // 🏠 Host tạo phòng
  socket.on("create_room", ({ roomCode, hostName, userId }) => {
    rooms[roomCode] = {
      host: userId,
      players: [
        {
          id: userId,
          socketId: socket.id,
          name: hostName,
          role: "host",
          status: "online",
          keyword: null,
        },
      ],
      settings: {
        villagers: 3,
        spies: 1,
        whiteHats: 0,
        keywords: { villager: "", spy: "", whiteHat: "" },
      },
      started: false,
    };

    socket.join(roomCode);
    io.to(socket.id).emit("room_created", roomCode);
    console.log(`🆕 Room ${roomCode} created by ${hostName}`);

    // Gửi danh sách players ngay cho host
    updatePlayers(roomCode);
    // Gửi danh sách phòng (nếu thay đổi)
    broadcastRoomList();
  });

  socket.on("join_room", ({ roomCode, playerName, userId }) => {
    const room = rooms[roomCode];
    if (!room) {
      io.to(socket.id).emit("error_message", "Phòng không tồn tại");
      return;
    }

    let player = room.players.find((p) => p.id === userId);

    if (player) {
      // reconnect
      player.socketId = socket.id;
      player.status = "online";
      player._rejoined = true;
    } else {
      // new player
      player = {
        id: userId,
        socketId: socket.id,
        name: playerName,
        role: "player",
        status: "online",
        keyword: null,
        _rejoined: false,
      };
      room.players.push(player);
    }

    // rời tất cả phòng cũ trước khi join lại
    for (const roomJoined of socket.rooms) {
      if (roomJoined !== socket.id) socket.leave(roomJoined);
    }

    socket.join(roomCode);

    // tránh duplicate emit
    if (!player._rejoined) {
      io.to(socket.id).emit("joined_success", {
        roomCode,
        host: room.players.find((p) => p.id === room.host)?.name || null,
      });
    }

    updatePlayers(roomCode);
    broadcastRoomList();
  });

  // leave_room
  socket.on("leave_room", ({ roomCode, userId }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find((p) => p.id === userId);
    if (!player) return;

    console.log(`🚪 ${player.name} rời phòng ${roomCode}`);

    // 💥 Nếu HOST thoát → xóa phòng ngay lập tức
    if (userId === room.host) {
      // Báo cho tất cả người trong phòng
      io.to(roomCode).emit("room_deleted", {
        message: "Host đã thoát phòng. Phòng đã bị giải tán.",
      });

      // Tống tất cả socket ra khỏi room
      io.in(roomCode).socketsLeave(roomCode);

      // Xóa phòng
      delete rooms[roomCode];
      broadcastRoomList();

      console.log(`🗑️ Host thoát → phòng ${roomCode} đã được xóa`);
      return;
    }

    // 🧍 Người chơi bình thường thoát
    room.players = room.players.filter((p) => p.id !== userId);
    socket.leave(roomCode);

    updatePlayers(roomCode);
    broadcastRoomList();
  });

  socket.on("update_settings", ({ roomCode, userId, newSettings }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== userId) return;
    room.settings = { ...room.settings, ...newSettings };
    io.to(roomCode).emit("settings_updated", room.settings);
  });

  // 🔹 Gửi danh sách phòng hiện tại khi client yêu cầu
  socket.on("get_rooms", () => {
    const list = Object.entries(rooms).map(([code, data]) => ({
      code,
      host: data.players.find((p) => p.id === data.host)?.name || "Ẩn danh",
      playerCount: data.players.length,
      started: data.started,
    }));
    io.to(socket.id).emit("room_list", list);
  });

  socket.on("start_game", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return;
    if (room.started) {
      io.to(socket.id).emit("error_message", "Game đã bắt đầu!");
      return;
    }
    if (room.host !== userId) {
      io.to(socket.id).emit(
        "error_message",
        "Chỉ host mới có thể bắt đầu game."
      );
      return;
    }

    const { villagers, spies, whiteHats, keywords } = room.settings;

    // Lấy danh sách players khả dụng (loại host và online)
    const availablePlayers = room.players.filter(
      (p) => p.role !== "host" && p.status === "online"
    );

    const totalNeeded = villagers + spies + whiteHats;

    if (availablePlayers.length < totalNeeded) {
      io.to(socket.id).emit(
        "error_message",
        `Cần ít nhất ${totalNeeded} người chơi (không tính host) để bắt đầu!`
      );
      return;
    }

    // Shuffle
    const shuffled = [...availablePlayers].sort(() => Math.random() - 0.5);

    // Chọn ra số người được assign
    const assignedSlice = shuffled.slice(0, totalNeeded);

    const assigned = [
      ...assignedSlice
        .slice(0, villagers)
        .map((p) => ({ ...p, role: "villager", keyword: keywords.villager })),
      ...assignedSlice
        .slice(villagers, villagers + spies)
        .map((p) => ({ ...p, role: "spy", keyword: keywords.spy })),
      ...assignedSlice
        .slice(villagers + spies, villagers + spies + whiteHats)
        .map((p) => ({ ...p, role: "whiteHat", keyword: keywords.whiteHat })),
    ];

    // Cập nhật room.players: giữ nguyên tất cả player, chỉ cập nhật role/keyword cho assigned
    room.players = room.players.map((p) => {
      const a = assigned.find((x) => x.id === p.id);
      if (a) return { ...p, role: a.role, keyword: a.keyword };
      return { ...p, keyword: null };
    });

    // Emit role riêng cho từng người đang online
    assigned.forEach((p) => {
      if (p.socketId) {
        io.to(p.socketId).emit("role_assigned", {
          role: p.role,
          keyword: p.keyword,
        });
      }
    });

    room.started = true;
    io.to(roomCode).emit("game_started");
    updatePlayers(roomCode);
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

  // Show thông tin người chơi cho host
  socket.on("get_player_info", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== userId) return;
    const reveal = room.players
      .filter((p) => p.role !== "host")
      .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));
    io.to(roomCode).emit("game_playing", reveal);
  });

  // disconnect
  socket.on("disconnect", () => {
    for (const [roomCode, room] of Object.entries(rooms)) {
      const player = room.players.find((p) => p.socketId === socket.id);
      if (player) {
        player.socketId = null;
        player.status = "offline";
        updatePlayers(roomCode);
        console.log(`⚠️ ${player.name} bị disconnect khỏi ${roomCode}`);
      }
    }
  });

  socket.on("reconnect_room", ({ roomCode, userId }) => {
    const room = getRoom(roomCode);
    if (!room) return;

    const player = room.players.find((p) => p.id === userId);
    if (!player) return;

    // Cập nhật socketId và status
    player.socketId = socket.id;
    player.status = "online";

    // Join lại room
    socket.join(roomCode);

    // Cập nhật danh sách players cho tất cả
    updatePlayers(roomCode);

    // Thông báo client đã reconnect thành công
    io.to(socket.id).emit("reconnected_success");

    // Nếu game đang diễn ra, gửi lại role và keyword
    if (
      room.started &&
      player.role &&
      player.role !== "player" &&
      player.role !== "host"
    ) {
      io.to(socket.id).emit("role_assigned", {
        role: player.role,
        keyword: player.keyword,
      });
    }

    // Nếu host reconnect, có thể gửi trạng thái game hiện tại
    if (player.role === "host") {
      const revealData = room.players
        .filter((p) => p.role !== "host")
        .map((p) => ({ name: p.name, role: p.role, keyword: p.keyword }));
      io.to(socket.id).emit("game_playing", revealData);
    }
  });

  socket.on("kick_player", ({ roomCode, hostId, playerId }) => {
    const room = getRoom(roomCode);
    if (!room || room.host !== hostId) return;

    const player = room.players.find((p) => p.id === playerId);
    if (!player) return;

    io.to(player.socketId).emit("kicked", "Bạn đã bị host đá khỏi phòng.");
    io.to(player.socketId).disconnectSockets(true); // kick trực tiếp
    room.players = room.players.filter((p) => p.id !== playerId);
    updatePlayers(roomCode);
  });
});

app.get("/", (_, res) => res.send("✅ Server đang chạy"));

const PORT = process.env.PORT || 5008;
server.listen(PORT, () => console.log(`🚀 Server chạy tại cổng ${PORT}`));
