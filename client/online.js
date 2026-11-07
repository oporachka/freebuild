(() => {
  const api = (location.hostname === 'oporachka.github.io' || location.protocol === 'file:') ? 'https://yosypnite.177-202-71-15.sslip.io' : location.origin;
  window.YosypAPI = api;
  class Connection {
    constructor(socket) { this.socket = socket; this.open = false; this.handlers = {}; }
    on(name, fn) { (this.handlers[name] ||= []).push(fn); return this; }
    emit(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
    send(payload) { if (this.open && this.socket.readyState === 1) this.socket.send(JSON.stringify({ t: 'data', payload })); }
    close() { this.open = false; this.socket.close(); }
  }
  window.YosypOnline = {
    connect({ host, code, game, nick, setup, status, created }) {
      const socket = new WebSocket(api.replace(/^http/, 'ws') + '/ws');
      const connection = new Connection(socket);
      setup(connection, host);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ t: host ? 'create' : 'join', code, game, nick, ver: 40 })));
      socket.addEventListener('message', event => {
        try {
          const m = JSON.parse(event.data);
          if (m.t === 'created') created(m.code);
          else if (m.t === 'paired') { connection.open = true; connection.emit('open'); }
          else if (m.t === 'data' && connection.open) connection.emit('data', m.payload);
          else if (m.t === 'error' || m.t === 'ended') { status(m.message); if (m.t === 'error') socket.close(); }
        } catch { status('Ошибка сетевого сообщения. Пересоздай комнату.'); }
      });
      socket.addEventListener('close', () => { connection.open = false; connection.emit('close'); });
      socket.addEventListener('error', () => status('Сервер недоступен. Проверь интернет и попробуй снова.'));
      return { destroy: () => socket.close() };
    }
  };
})();
