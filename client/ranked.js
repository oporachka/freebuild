(() => {
  const $ = id => document.getElementById(id), game = window.GameRankedBridge;
  let handle = null, searching = false, playing = false, searchUid = null, rating = null;
  const number = n => Number(n || 0).toLocaleString('ru-RU');
  function controls() {
    $('rankedFind').disabled = searching || playing;
    $('rankedFind').textContent = searching ? 'ПОИСК СОПЕРНИКА…' : playing ? 'МАТЧ НАЙДЕН' : window.YosypAccount?.active ? 'НАЙТИ СОПЕРНИКА' : 'ВОЙТИ И ИГРАТЬ';
    $('rankedCancel').hidden = !searching;
    for (const id of ['bHost', 'bJoin', 'joinCode']) $(id).disabled = searching || playing;
  }
  function profile(value) {
    rating = value || null;
    $('rankedPts').textContent = rating ? number(rating.pts) : '—';
    $('rankedRecord').textContent = rating ? `${rating.wins} побед · ${rating.losses} поражений` : '1 000 ПТС на старте · нужен аккаунт';
    $('lobbyRankedLabel').textContent = rating ? `${number(rating.pts)} ПТС · дуэль 1×1 до 5 побед` : 'Рейтинг 1×1 и комнаты с друзьями';
    $('accountRanked').textContent = rating ? `${number(rating.pts)} ПТС · ${rating.wins} побед · ${rating.losses} поражений` : '';
    controls();
  }
  function dispose() { const previous = handle; handle = null; searching = playing = false; previous?.destroy(); controls(); }
  function showResult(m) {
    handle = null; searching = playing = false; controls(); game.finish();
    if (m.rating) profile(m.rating);
    $('rankedResultTitle').textContent = m.outcome === 'win' ? 'ПОБЕДА' : m.outcome === 'loss' ? 'ПОРАЖЕНИЕ' : 'МАТЧ ЗАВЕРШЁН';
    $('rankedResult').dataset.outcome = m.outcome;
    $('rankedResultScore').textContent = `${m.score[0]} : ${m.score[1]}`;
    $('rankedResultPts').textContent = `${m.delta > 0 ? '+' : ''}${m.delta} ПТС`;
    $('rankedResultBalance').textContent = `Твой рейтинг: ${number(m.rating.pts)} ПТС`;
    $('rankedResultReason').textContent = ({ win: 'Дуэль до пяти побед завершена.', forfeit: m.outcome === 'win' ? 'Соперник покинул матч.' : 'Выход из начавшейся дуэли засчитан как поражение.', cancelled: 'Один из игроков не подготовился. ПТС сохранены.', server_restart: 'Сервер перезапущен. ПТС сохранены.', timeout: 'Время матча истекло. ПТС сохранены.' })[m.reason] || '';
    if (!$('rankedResult').open) $('rankedResult').showModal();
    window.YosypAccount?.refresh().catch(() => {});
  }
  function failed(message) {
    const wasPlaying = playing; dispose();
    if (wasPlaying) game.finish();
    $('rankedStatus').textContent = message; game.notice(message);
    window.YosypAccount?.refresh().catch(() => {});
  }
  function start() {
    if (handle) return;
    if (!window.YosypAccount?.active) { window.YosypAccount?.open(); return; }
    searchUid = window.YosypAccount.uid; searching = true; controls(); game.search();
    $('rankedStatus').textContent = 'Подключаемся к рейтинговой очереди…';
    handle = window.YosypOnline.queue({
      getToken: () => window.YosypAccount.getToken(),
      queued: m => { $('rankedStatus').textContent = `Поиск ${Math.floor(m.seconds / 60)}:${String(m.seconds % 60).padStart(2, '0')} · диапазон ±${m.range} ПТС`; },
      matched: (connection, m) => { searching = false; playing = true; controls(); game.prepare(connection, m); },
      state: m => game.state(m), correction: position => game.correct(position), hit: m => game.hit(m), result: showResult, error: failed
    });
  }
  window.YosypRanked = {
    profile, start, get busy() { return searching || playing; },
    accountChanged(uid) { if (handle && uid !== searchUid) { const wasPlaying = playing; dispose(); if (wasPlaying) game.finish(); } if (uid !== searchUid || !uid) { if ($('rankedResult').open) $('rankedResult').close(); profile(null); } },
    cancelQueue() { if (searching) { dispose(); $('rankedStatus').textContent = 'Поиск отменён. ПТС не изменились.'; } },
    forfeit() { if (playing) { game.notice('Завершаем дуэль…'); handle?.forfeit(); } }
  };
  $('rankedFind').onclick = start;
  $('rankedCancel').onclick = () => window.YosypRanked.cancelQueue();
  $('rankedAgain').onclick = () => { $('rankedResult').close(); start(); };
  $('rankedDone').onclick = () => $('rankedResult').close();
  profile(window.YosypAccount?.profile?.ranked);
})();
