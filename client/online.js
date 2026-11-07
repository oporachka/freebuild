(() => {
  const api = (location.hostname === 'oporachka.github.io' || location.protocol === 'file:') ? 'https://yosypnite.177-202-71-15.sslip.io' : location.origin;
  window.YosypAPI = api;
  class Connection {
    constructor(socket) { this.socket = socket; this.open = false; this.handlers = {}; }
    on(name, fn) { (this.handlers[name] ||= []).push(fn); return this; }
    emit(name, value) { for (const fn of this.handlers[name] || []) fn(value); }
    send(payload) { if (!this.open || this.socket.readyState !== 1) return; if (payload.t === 'ping') { this.socket.send(JSON.stringify({ t: 'server_ping', k: payload.k })); if (this.ranked) return; } this.socket.send(JSON.stringify({ t: 'data', ...(this.ranked ? { round: this.round } : {}), payload })); }
    ready() { if (this.ranked && this.socket.readyState === 1) this.socket.send(JSON.stringify({ t: 'ranked_ready' })); }
    close() { this.open = false; this.socket.close(); }
  }
  window.YosypOnline = {
    connect({ host, code, game, nick, setup, status, created }) {
      const socket = new WebSocket(api.replace(/^http/, 'ws') + '/ws');
      const connection = new Connection(socket);
      setup(connection, host);
      socket.addEventListener('open', () => socket.send(JSON.stringify({ t: host ? 'create' : 'join', code, game, nick, ver: 41 })));
      socket.addEventListener('message', event => {
        try {
          const m = JSON.parse(event.data);
          if (m.t === 'created') created(m.code);
          else if (m.t === 'paired') { connection.open = true; connection.emit('open'); }
          else if (m.t === 'data' && connection.open) connection.emit('data', m.payload);
          else if (m.t === 'server_pong') connection.emit('data', { t: 'serverpong', k: m.k });
          else if (m.t === 'error' || m.t === 'ended') { status(m.message); if (m.t === 'error') socket.close(); }
        } catch { status('Ошибка сетевого сообщения. Пересоздай комнату.'); }
      });
      socket.addEventListener('close', () => { connection.open = false; connection.emit('close'); });
      socket.addEventListener('error', () => status('Сервер недоступен. Проверь интернет и попробуй снова.'));
      return { destroy: () => socket.close() };
    },
    queue({ getToken, queued, matched, state, result, correction, hit, error }) {
      let socket, connection, cancelled = false, finished = false;
      const fail = message => { if (!cancelled && !finished) { finished = true; error(message); } };
      (async () => {
        try {
          const token = await getToken(); if (cancelled) return;
          socket = new WebSocket(api.replace(/^http/, 'ws') + '/ws');
          connection = new Connection(socket); connection.ranked = true; connection.round = 0;
          socket.addEventListener('open', () => { if (cancelled) socket.close(); else socket.send(JSON.stringify({ t: 'ranked_queue', ver: 41, token })); });
          socket.addEventListener('message', event => {
            if (cancelled || finished) return;
            try {
              const m = JSON.parse(event.data);
              if (m.t === 'ranked_queued') queued(m);
              else if (m.t === 'ranked_matched') { connection.open = true; matched(connection, m); }
              else if (m.t === 'ranked_state') { connection.round = m.round; state(m); }
              else if (m.t === 'ranked_correction') { if (m.round === connection.round) correction(m.position); }
              else if (m.t === 'ranked_hit') hit(m);
              else if (m.t === 'ranked_result') { finished = true; connection.open = false; result(m); }
              else if (m.t === 'data') connection.emit('data', m.payload);
              else if (m.t === 'server_pong') connection.emit('data', { t: 'serverpong', k: m.k });
              else if (m.t === 'error') { fail(m.message); socket.close(); }
            } catch { fail('Не удалось обработать ответ рейтингового сервера.'); socket.close(); }
          });
          socket.addEventListener('error', () => fail('Нет связи с рейтинговым сервером. Попробуй ещё раз.'));
          socket.addEventListener('close', () => { connection.open = false; fail('Связь прервалась. ПТС обновятся после подключения к серверу.'); });
        } catch (e) { fail(e.message || 'Не удалось начать поиск.'); }
      })();
      return {
        destroy() { cancelled = true; if (socket?.readyState === 1) socket.send(JSON.stringify({ t: 'ranked_cancel' })); socket?.close(); },
        forfeit() { connection?.send({ t: 'bye' }); }
      };
    }
  };
})();
