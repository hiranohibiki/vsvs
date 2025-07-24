// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// 静的ファイル配信
app.use(express.static(path.join(__dirname, 'public')));

// ==== マッチング用部屋管理 ====
const ROOM_NAMES = ['room1', 'room2', 'room3', 'room4'];

// 部屋の状態を管理するクラス
class RoomManager {
  constructor() {
    this.rooms = {
      room1: [],
      room2: [],
      room3: [],
      room4: []
    };
    
    this.userNames = {
      room1: {},
      room2: {},
      room3: {},
      room4: {}
    };
    
    this.userIcons = {
      room1: {},
      room2: {},
      room3: {},
      room4: {}
    };
    
    this.rematchRequests = {
      room1: [],
      room2: [],
      room3: [],
      room4: []
    };
    
    this.finishRequests = {
      room1: [],
      room2: [],
      room3: [],
      room4: []
    };
    
    // 対戦中のフラグ（部屋ごと）
    this.gameInProgress = {
      room1: false,
      room2: false,
      room3: false,
      room4: false
    };
    
    // 退出処理中のユーザー
    this.leavingUsers = new Set();
  }
  
  // 部屋の状態を取得
  getRoomStatus() {
    const status = {};
    for (const room of ROOM_NAMES) {
      status[room] = this.rooms[room].length;
    }
    return status;
  }
  
  // ユーザーを部屋に追加
  addUserToRoom(roomName, socketId, userName, userIcon) {
    if (!ROOM_NAMES.includes(roomName)) return false;
    if (this.rooms[roomName].length >= 2) return false;
    if (this.rooms[roomName].includes(socketId)) return false;
    
    // 対戦中の部屋には入室できない
    if (this.gameInProgress[roomName]) return false;
    
    // 退出処理中の部屋には入室できない
    if (this.hasLeavingUsers(roomName)) return false;
    
    this.rooms[roomName].push(socketId);
    this.userNames[roomName][socketId] = userName;
    this.userIcons[roomName][socketId] = userIcon;
    
    return true;
  }
  
  // ユーザーを部屋から削除
  removeUserFromRoom(roomName, socketId) {
    if (!ROOM_NAMES.includes(roomName)) return false;
    
    const userIndex = this.rooms[roomName].indexOf(socketId);
    if (userIndex === -1) return false;
    
    this.rooms[roomName].splice(userIndex, 1);
    delete this.userNames[roomName][socketId];
    delete this.userIcons[roomName][socketId];
    
    // リクエストからも削除
    this.removeFromRequests(roomName, socketId);
    
    return true;
  }
  
  // リクエストからユーザーを削除
  removeFromRequests(roomName, socketId) {
    const rematchIndex = this.rematchRequests[roomName].indexOf(socketId);
    if (rematchIndex !== -1) {
      this.rematchRequests[roomName].splice(rematchIndex, 1);
    }
    
    const finishIndex = this.finishRequests[roomName].indexOf(socketId);
    if (finishIndex !== -1) {
      this.finishRequests[roomName].splice(finishIndex, 1);
    }
  }
  
  // 対戦開始
  startGame(roomName) {
    if (!ROOM_NAMES.includes(roomName)) return false;
    this.gameInProgress[roomName] = true;
    return true;
  }
  
  // 対戦終了
  endGame(roomName) {
    if (!ROOM_NAMES.includes(roomName)) return false;
    this.gameInProgress[roomName] = false;
    return true;
  }
  
  // 部屋の全ユーザーを取得
  getRoomUsers(roomName) {
    if (!ROOM_NAMES.includes(roomName)) return [];
    return [...this.rooms[roomName]];
  }
  
  // 部屋のユーザー情報を取得
  getRoomUserInfo(roomName) {
    if (!ROOM_NAMES.includes(roomName)) return { names: {}, icons: {} };
    return {
      names: { ...this.userNames[roomName] },
      icons: { ...this.userIcons[roomName] }
    };
  }
  
  // 退出処理中のユーザーをマーク
  markAsLeaving(socketId) {
    this.leavingUsers.add(socketId);
  }
  
  // 退出処理完了
  markAsLeft(socketId) {
    this.leavingUsers.delete(socketId);
  }
  
  // 退出処理中のユーザーがいるかチェック
  hasLeavingUsers(roomName) {
    if (!ROOM_NAMES.includes(roomName)) return false;
    return this.rooms[roomName].some(id => this.leavingUsers.has(id));
  }
  
  // 部屋をクリア（全ユーザーを削除）
  clearRoom(roomName) {
    // 部屋の全ユーザーIDをleavingUsersから削除
    for (const id of this.rooms[roomName]) {
      this.leavingUsers.delete(id);
    }
    this.rooms[roomName] = [];
    this.userNames[roomName] = {};
    this.userIcons[roomName] = {};
    this.rematchRequests[roomName] = [];
    this.finishRequests[roomName] = [];
    this.gameInProgress[roomName] = false;
  }
}

// グローバルな部屋マネージャーインスタンス
const roomManager = new RoomManager();

// 部屋の状態を全クライアントに通知
function broadcastRoomStatus() {
  const status = roomManager.getRoomStatus();
  const leavingStatus = {};
  
  // 退出処理中の部屋情報も含める
  for (const room of ROOM_NAMES) {
    leavingStatus[room] = roomManager.hasLeavingUsers(room);
  }
  
  io.emit('room_status', { status, leavingStatus });
}

// 両者の名前・アイコンが揃ってからroom_readyをemitする
function tryEmitRoomReady(roomName) {
  const users = roomManager.getRoomUsers(roomName);
  if (users.length === 2) {
    const userInfo = roomManager.getRoomUserInfo(roomName);
    const names = userInfo.names;
    const icons = userInfo.icons;
    
    // 退出処理中のユーザーがいるかチェック
    if (roomManager.hasLeavingUsers(roomName)) {
      console.log(`Room ${roomName} has leaving user, delaying room_ready`);
      setTimeout(() => tryEmitRoomReady(roomName), 100);
      return;
    }
    
    if (!names[users[0]] || !names[users[1]] || !icons[users[0]] || !icons[users[1]]
      || names[users[0]] === '' || names[users[1]] === ''
      || icons[users[0]] === '' || icons[users[1]] === '') {
      setTimeout(() => tryEmitRoomReady(roomName), 50);
      return;
    }
    const hostId = users[0];
    // 対戦を開始
    roomManager.startGame(roomName);
    // サーバー時刻でゲーム開始時刻を決定
    const startTime = Date.now();
    io.to(roomName).emit('room_ready', { room: roomName, hostId, names: { ...names }, icons: { ...icons }, startTime });
  }
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // 部屋一覧リクエスト
  socket.on('get_rooms', () => {
    const status = roomManager.getRoomStatus();
    const leavingStatus = {};
    
    // 退出処理中の部屋情報も含める
    for (const room of ROOM_NAMES) {
      leavingStatus[room] = roomManager.hasLeavingUsers(room);
    }
    
    socket.emit('room_status', { status, leavingStatus });
  });

  // 部屋入室リクエスト
  socket.on('join_room', (data) => {
    const roomName = data.roomName;
    const name = data.name || '名無し';
    const icon = data.icon || '👤';

    // すでに部屋にいる場合は一度退出
    for (const r of ROOM_NAMES) {
      if (roomManager.removeUserFromRoom(r, socket.id)) {
        socket.leave(r);
      }
    }

    // 切断済みIDを除去
    for (const r of ROOM_NAMES) {
      roomManager.rooms[r] = roomManager.rooms[r].filter(id => io.sockets.sockets.get(id));
    }

    // サーバー側で入室可否を判定
    if (roomManager.rooms[roomName].length >= 2 || roomManager.gameInProgress[roomName]) {
      // 満室または対戦中
      socket.emit('join_room_failed', { reason: 'room_full_or_game_in_progress' });
      return;
    }
    if (roomManager.hasLeavingUsers(roomName)) {
      // 退出処理中
      socket.emit('join_room_failed', { reason: 'leaving_in_progress' });
      return;
    }

    // 入室処理
    if (roomManager.addUserToRoom(roomName, socket.id, name, icon)) {
      socket.join(roomName);
      socket.emit('room_joined', { room: roomName });
      broadcastRoomStatus();
      // 2人揃ったらマッチング開始
      const users = roomManager.getRoomUsers(roomName);
      if (users.length === 2) {
        if (!roomManager.hasLeavingUsers(roomName)) {
          tryEmitRoomReady(roomName);
        }
      }
    } else {
      socket.emit('join_room_failed', { reason: 'room_full_or_game_in_progress' });
    }
  });

  // 再戦リクエスト
  socket.on('rematch_request', (roomName) => {
    if (!ROOM_NAMES.includes(roomName)) return;
    const users = roomManager.getRoomUsers(roomName);
    if (!users.includes(socket.id)) return;
    
    if (!roomManager.rematchRequests[roomName].includes(socket.id)) {
      roomManager.rematchRequests[roomName].push(socket.id);
    }
    
    // 相手に再戦希望通知
    users.forEach(id => {
      if (id !== socket.id) {
        io.to(id).emit('rematch_notice');
      }
    });
    
    // 2人揃ったら再度room_ready
    if (roomManager.rematchRequests[roomName].length === 2) {
      // 切断済みIDを除去
      roomManager.rooms[roomName] = roomManager.rooms[roomName].filter(id => io.sockets.sockets.get(id));
      
      // 退出処理中のユーザーがいる場合はroom_readyを発火させない
      if (!roomManager.hasLeavingUsers(roomName)) {
        tryEmitRoomReady(roomName);
      } else {
        console.log(`Room ${roomName} has leaving user during rematch, not emitting room_ready`);
      }
      roomManager.rematchRequests[roomName] = [];
    }
  });

  // 完成ボタン押下
  socket.on('finish_request', (roomName) => {
    if (!ROOM_NAMES.includes(roomName)) return;
    const users = roomManager.getRoomUsers(roomName);
    if (!users.includes(socket.id)) return;
    
    if (!roomManager.finishRequests[roomName].includes(socket.id)) {
      roomManager.finishRequests[roomName].push(socket.id);
    }
    
    // 相手に完成通知
    users.forEach(id => {
      if (id !== socket.id) {
        io.to(id).emit('finish_notice');
      }
    });
    
    // 2人揃ったら両者にresult_readyをemit
    if (roomManager.finishRequests[roomName].length === 2) {
      io.to(roomName).emit('result_ready');
      roomManager.finishRequests[roomName] = [];
    }
  });

  // 部屋退出リクエスト
  socket.on('leave_room', (data) => {
    const roomName = data.room;
    if (!ROOM_NAMES.includes(roomName)) return;

    // サーバー側で部屋からユーザーを削除
    if (roomManager.removeUserFromRoom(roomName, socket.id)) {
      socket.leave(roomName);
      socket.emit('leave_room_success', { room: roomName });
      broadcastRoomStatus();
      // 残ったユーザーがいれば相手退出通知
      const users = roomManager.getRoomUsers(roomName);
      if (users.length > 0) {
        users.forEach(id => {
          io.to(id).emit('opponent_left');
        });
      } else {
        roomManager.clearRoom(roomName);
      }
    }
  });

  // 切断時に部屋から除外
  socket.on('disconnect', () => {
    for (const roomName of ROOM_NAMES) {
      if (roomManager.rooms[roomName].includes(socket.id)) {
        // 部屋の全ユーザーを取得
        const users = roomManager.getRoomUsers(roomName);

        // 全員を部屋から除外し、force_leaveを送信
        users.forEach(id => {
          roomManager.removeUserFromRoom(roomName, id);
          io.to(id).emit('force_leave');
          const s = io.sockets.sockets.get(id);
          if (s) s.leave(roomName);
        });

        // 部屋をクリア
        roomManager.clearRoom(roomName);
        broadcastRoomStatus();
      }
    }
  });

  // お題リレー
  socket.on('send_topic', (data) => {
    if (!data.room || !data.topic) return;
    // サーバー時刻でゲーム開始時刻を決定
    const startTime = Date.now();
    // 部屋全員にお題と開始時刻を配信
    io.to(data.room).emit('receive_topic', { topic: data.topic, startTime });
  });

  // 描画データリレー
  socket.on('draw', (data) => {
    if (!data.room) return;
    socket.to(data.room).emit('draw', data);
  });

  // 退出処理完了通知
  socket.on('leave_complete', () => {
    console.log(`User ${socket.id} completed leaving process`);
    roomManager.markAsLeft(socket.id);
  });

  // ゲーム終了通知
  socket.on('game_end', (data) => {
    const roomName = data.room;
    if (!ROOM_NAMES.includes(roomName)) return;
    
    console.log(`Game ended in room: ${roomName}`);
    roomManager.endGame(roomName);
  });

  // 判定・結果リレー（必要に応じて拡張）
  socket.on('result', (data) => {
    if (!data.room) return;
    socket.to(data.room).emit('result', data);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
