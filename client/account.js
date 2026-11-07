const byId = id => document.getElementById(id);
const bridge = window.GameAccountBridge;
const cloud = window.YosypAccount = { active: false, uid: null, profile: null, user: null };
let sdk, auth, session, rewardQueue = Promise.resolve(), equipTimer, applying = false, guestSnapshot, authGeneration = 0;
const dialog = byId('accountDialog');
function message(text) { byId('accountMessage').textContent = text; }
function show() { bridge.pause(); if (!dialog.open) dialog.showModal(); }
cloud.open = show;
cloud.getToken = async () => { const user = cloud.user; if (!cloud.active || !user?.emailVerified) throw new Error('Войди в аккаунт с подтверждённой почтой.'); const token = await user.getIdToken(); if (cloud.user?.uid !== user.uid) throw new Error('Аккаунт изменился. Повтори поиск.'); return token; };
cloud.refresh = async () => { if (cloud.active) apply(await request('profile')); };
byId('accountButton').onclick = show;
byId('accountClose').onclick = () => dialog.close();
byId('accountGuest').onclick = () => dialog.close();
function passwordVisibility(visible) {
  byId('accountPassword').type = visible ? 'text' : 'password';
  byId('accountPasswordToggle').setAttribute('aria-pressed', String(visible));
  byId('accountPasswordToggle').setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
}
function clearPassword() { byId('accountPassword').value = ''; passwordVisibility(false); }
byId('accountPasswordToggle').onclick = () => passwordVisibility(byId('accountPassword').type === 'password');
dialog.onclose = clearPassword;
function errorText(e) {
  return ({ 'auth/invalid-credential': 'Неверная почта или пароль.', 'auth/email-already-in-use': 'Эта почта уже зарегистрирована. Войди или восстанови пароль.', 'auth/weak-password': 'Используй пароль от 6 символов.', 'auth/invalid-email': 'Проверь адрес почты.', 'auth/popup-blocked': 'Разреши всплывающее окно для входа через Google.', 'auth/popup-closed-by-user': 'Окно входа закрыто.', 'auth/too-many-requests': 'Слишком много попыток. Попробуй позже.', 'auth/network-request-failed': 'Нет связи с сервисом входа.', 'auth/account-exists-with-different-credential': 'Этот адрес уже зарегистрирован другим способом. Сначала войди по почте.' })[e.code] || e.message || 'Не удалось выполнить действие.';
}
async function request(route, body, retry = true) {
  const user = cloud.user;
  const token = await user?.getIdToken();
  if (!token) throw new Error('Войди в аккаунт.');
  const res = await fetch(window.YosypAPI + '/api/' + route, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (cloud.user?.uid !== user.uid) throw new Error('Аккаунт изменился. Повтори действие.');
  if (res.status === 401 && retry) { await user.getIdToken(true); return request(route, body, false); }
  const value = await res.json(); if (!res.ok) throw new Error(value.error || 'Ошибка сервера.'); return value;
}
function apply(profile) {
  if (cloud.profile && profile.revision < cloud.profile.revision) return;
  cloud.profile = profile; applying = true; bridge.apply(profile); applying = false;
  byId('accountButton').textContent = 'АККАУНТ ✓';
  byId('accountIdentity').textContent = cloud.user.email || profile.nick;
  window.YosypRanked?.profile(profile.ranked);
}
async function action(fn) {
  const buttons = [...dialog.querySelectorAll('[data-account-action]')]; buttons.forEach(b => b.disabled = true);
  dialog.ariaBusy = 'true';
  try { await fn(); } catch (e) { message(errorText(e)); } finally { buttons.forEach(b => b.disabled = false); dialog.ariaBusy = 'false'; }
}
function formValues() { return { email: byId('accountEmail').value.trim(), password: byId('accountPassword').value }; }
byId('accountForm').onsubmit = event => { event.preventDefault(); action(async () => { if (!auth) throw new Error('Сервис входа ещё загружается.'); const v = formValues(); await sdk.signInWithEmailAndPassword(auth, v.email, v.password); clearPassword(); }); };
byId('accountRegister').onclick = () => { if (!byId('accountForm').reportValidity()) return; action(async () => {
  if (!auth) throw new Error('Сервис входа ещё загружается.');
  const v = formValues(); if (v.password.length < 6) throw new Error('Используй пароль от 6 символов.');
  const credential = await sdk.createUserWithEmailAndPassword(auth, v.email, v.password);
  await sdk.sendEmailVerification(credential.user); clearPassword(); message('Письмо отправлено. Подтверди почту по ссылке, затем нажми «Я подтвердил почту».');
}); };
byId('accountGoogle').onclick = () => action(async () => { if (!auth) throw new Error('Сервис входа ещё загружается.'); await sdk.signInWithPopup(auth, new sdk.GoogleAuthProvider()); });
byId('accountReset').onclick = () => { if (!byId('accountEmail').reportValidity()) return; action(async () => {
  if (!auth) throw new Error('Сервис входа ещё загружается.');
  await sdk.sendPasswordResetEmail(auth, formValues().email); message('Если аккаунт с такой почтой существует, придёт письмо для восстановления.');
}); };
byId('accountVerify').onclick = () => action(async () => { await sdk.reload(auth.currentUser); await auth.currentUser.getIdToken(true); await signedIn(auth.currentUser); });
byId('accountResend').onclick = () => action(async () => { await sdk.sendEmailVerification(auth.currentUser); message('Письмо подтверждения отправлено.'); });
byId('accountLogout').onclick = () => action(async () => { await sdk.signOut(auth); message('Ты вышел. Локальные сохранения гостя восстановлены.'); });
byId('accountRefresh').onclick = () => action(() => signedIn(auth.currentUser));
byId('accountMigrate').onclick = () => action(async () => {
  let installation = localStorage.getItem('yosyp-installation');
  if (!installation) { installation = crypto.randomUUID(); localStorage.setItem('yosyp-installation', installation); }
  apply(await request('migrate', { operationId: crypto.randomUUID(), installation, owned: guestSnapshot.owned }));
  byId('accountMigration').hidden = true; message('Покупки перенесены. Баланс аккаунта не изменён.');
});
async function signedIn(user) {
  const generation = ++authGeneration;
  clearTimeout(equipTimer);
  cloud.user = user; cloud.active = false; cloud.uid = user?.uid || null; session = null; cloud.profile = null;
  window.YosypRanked?.accountChanged(cloud.uid);
  byId('accountFormSection').hidden = !!user; byId('accountUserSection').hidden = !user;
  byId('accountGuestHint').hidden = !!user;
  byId('accountVerification').hidden = !user || user.emailVerified;
  byId('accountMigration').hidden = true;
  if (!user) {
    if (guestSnapshot) { applying = true; bridge.apply(guestSnapshot); applying = false; }
    byId('accountButton').textContent = 'ВОЙТИ'; return;
  }
  if (!guestSnapshot) guestSnapshot = bridge.snapshot();
  byId('accountIdentity').textContent = user.email || 'Аккаунт';
  if (!user.emailVerified) { message('Подтверди почту, чтобы подключить сохранения.'); return; }
  try {
    const profile = await request('profile'); if (generation !== authGeneration) return; cloud.active = true; apply(profile);
    byId('accountMigration').hidden = profile.migrated;
    message('Сохранения подключены. Покупки доступны на всех твоих устройствах.');
    if (bridge.playing()) cloud.beginPlay();
  } catch (e) { if (generation !== authGeneration) return; message(errorText(e)); byId('accountButton').textContent = 'ПОВТОРИТЬ ВХОД'; }
}
cloud.saveLocal = (key, value) => {
  if (key !== 'fb_settings' || !cloud.active) return false;
  // Account inventory must never replace the browser's legacy guest save.
  const device = bridge.deviceSettings(value);
  try { const guest = JSON.parse(localStorage.getItem('fb_settings') || '{}'); localStorage.setItem('fb_settings', JSON.stringify({ ...guest, ...device })); } catch {}
  if (!applying) { const desired = bridge.equipment(); clearTimeout(equipTimer); equipTimer = setTimeout(() => request('equip', desired).then(apply).catch(e => bridge.notify(errorText(e))), 500); }
  return true;
};
cloud.purchase = async selection => {
  if (cloud.busy) return;
  cloud.busy = true;
  try { apply(await request('purchase', { operationId: crypto.randomUUID(), ...(selection.kind === 'bundle' ? { bundle: selection.id } : { key: selection.key, idx: selection.idx }) })); bridge.notify('Предметы сохранены в аккаунте.'); }
  catch (e) { bridge.notify(errorText(e)); } finally { cloud.busy = false; }
};
cloud.beginPlay = () => {
  if (!cloud.active) return;
  session = request('play', {}).then(v => v.id).catch(e => { bridge.notify(errorText(e)); return null; });
};
cloud.resumePlay = () => { if (cloud.active && !session) cloud.beginPlay(); };
cloud.reward = (amount, reason) => {
  const current = session;
  rewardQueue = rewardQueue.catch(() => {}).then(async () => {
    if (!cloud.active || !current) return;
    const id = await current; if (!id) return;
    try { apply(await request('reward', { operationId: crypto.randomUUID(), session: id, kind: amount === 60 ? 'fat' : 'normal' })); bridge.notify('+' + amount + ' Эндер-баксов · ' + reason); }
    catch (e) { bridge.notify(errorText(e)); }
  });
};
document.addEventListener('visibilitychange', () => { if (!document.hidden && cloud.active) request('profile').then(apply).catch(() => {}); });
try {
  if (window.location?.protocol === 'file:') throw new Error('Скачанный HTML подходит для одиночной игры. Для аккаунта и онлайна открой сайт Йосыпнайта.');
  const res = await fetch(window.YosypAPI + '/api/config', { signal: AbortSignal.timeout(10000) });
  const { firebase } = await res.json();
  if (!firebase?.apiKey) throw new Error('Вход пока настраивается. Игра гостем уже доступна.');
  const appSDK = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js');
  sdk = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js');
  auth = sdk.getAuth(appSDK.initializeApp(firebase)); auth.languageCode = 'ru';
  await sdk.setPersistence(auth, sdk.browserLocalPersistence);
  sdk.onAuthStateChanged(auth, user => signedIn(user));
} catch (e) { message(errorText(e)); }
export { signedIn };
