import { readSourceFile } from './source-file.js';

(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const maxFileSize = 1024 * 1024;
  const allowedExtensions = /\.(cpp|cc|cxx|c|py|java|pas)$/i;
  const state = { session: null, cards: new Map(), toastTimer: null, revision: 0 };
  const loginForm = $('#login-form');
  const codeDialog = $('#code-dialog');
  const messageDialog = $('#message-dialog');
  const dialogTriggers = new WeakMap();

  function openDialog(dialog, trigger) {
    dialogTriggers.set(dialog, trigger);
    dialog.showModal();
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: { 'Content-Type': 'application/json', ...options.headers },
      });
    } catch {
      throw new Error('连接失败，请检查网络后重试。');
    }
    if (response.status === 401 && path !== '/api/login') {
      showLogin('登录已过期，请重新登录。');
      throw new Error('登录已过期，请重新登录。');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '操作失败，请稍后重试。');
    return data;
  }

  function showToast(message) {
    clearTimeout(state.toastTimer);
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    state.toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
  }

  function setError(element, message = '') {
    element.textContent = message;
    element.hidden = !message;
  }

  function closeAccountMenu() {
    $('#account-menu').hidden = true;
    $('#account-toggle').setAttribute('aria-expanded', 'false');
  }

  function showLogin(error = '') {
    state.revision += 1;
    state.session = null;
    state.cards.clear();
    clearTimeout(state.toastTimer);
    $('#toast').hidden = true;
    $('#problems').replaceChildren();
    $('#exam-view').hidden = true;
    $('#account').hidden = true;
    $('#loading-view').hidden = true;
    $('#login-view').hidden = false;
    $('#password').value = '';
    $('#code-content').textContent = '';
    codeDialog.close();
    messageDialog.close();
    closeAccountMenu();
    setError($('#login-error'), error);
    document.title = '登录 - 信息学竞赛考试系统';
    if (location.pathname !== '/') history.replaceState(null, '', '/');
  }

  function showExam(session) {
    state.revision += 1;
    state.session = session;
    const { user, exam, submissions = {} } = session;
    $('#header-candidate').textContent = user.candidateId;
    $('#account-name').textContent = user.name;
    $('#exam-title').textContent = exam.title;
    $('#student-name').textContent = `${user.name}, ${user.candidateId}`;
    $('#student-school').textContent = user.school;
    $('#student-grade').textContent = user.grade;
    $('#student-room').textContent = user.room;
    $('#exam-password').textContent = exam.password || 'None';
    const ongoing = exam.status === 'ongoing';
    $('#exam-status').textContent = ongoing ? '考试进行中' : '考试已结束';
    $('#exam-status').classList.toggle('ended', !ongoing);
    $('#problems').replaceChildren();
    state.cards.clear();
    for (const problemId of exam.problems) createProblem(problemId, submissions[problemId]);
    $('#password').value = '';
    $('#loading-view').hidden = true;
    $('#login-view').hidden = true;
    $('#exam-view').hidden = false;
    $('#account').hidden = false;
    document.title = '考试页面 - 信息学竞赛考试系统';
    if (location.pathname !== '/student/') history.replaceState(null, '', '/student/');
  }

  function createProblem(problemId, submission) {
    const fragment = $('#problem-template').content.cloneNode(true);
    const card = $('.problem-card', fragment);
    card.dataset.problem = problemId;
    $('.problem-title', card).textContent = problemId;
    const fileInput = $('.file-input', card);
    fileInput.setAttribute('aria-label', `选择 ${problemId} 题的源代码文件`);
    fileInput.disabled = state.session.exam.status !== 'ongoing';
    $('.submit-button', card).setAttribute('aria-label', `提交 ${problemId} 题`);
    $('.view-button', card).setAttribute('aria-label', `查看 ${problemId} 题已提交代码`);
    state.cards.set(problemId, card);
    fileInput.addEventListener('change', () => selectFile(card));
    $('.submit-button', card).addEventListener('click', () => submitFile(problemId, card));
    $('.view-button', card).addEventListener('click', () => viewCode(problemId, card));
    $('#problems').append(fragment);
    if (submission) renderSubmission(card, submission);
  }

  function renderSubmission(card, submission) {
    card.classList.add('is-submitted');
    $('.status-text', card).textContent = '已提交';
    $('.resubmit-hint', card).hidden = state.session.exam.status !== 'ongoing';
    $('.submission-meta', card).hidden = false;
    $('.submitted-name', card).textContent = submission.fileName;
    $('.submitted-name', card).title = submission.fileName;
    $('.submitted-size', card).textContent = `${(submission.size / 1024).toFixed(2)} KB`;
    const time = new Date(submission.submittedAt);
    $('.submitted-time', card).textContent = time.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    $('.submitted-time', card).dateTime = submission.submittedAt;
    $('.submitted-time', card).title = time.toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    $('.view-button', card).hidden = false;
  }

  function selectFile(card) {
    const input = $('.file-input', card);
    const file = input.files[0];
    let error = '';
    if (file && !allowedExtensions.test(file.name)) error = '请选择 C/C++、Python、Java 或 Pascal 源代码文件。';
    else if (file && file.size > maxFileSize) error = '文件不能超过 1 MB，请重新选择。';
    else if (file && file.size === 0) error = '文件内容为空，请重新选择。';
    if (error) input.value = '';
    const selected = input.files[0];
    $('.selected-name', card).textContent = selected ? selected.name : '（未选择）';
    $('.selected-name', card).title = selected ? selected.name : '';
    $('.submit-button', card).disabled = !selected || state.session?.exam.status !== 'ongoing';
    setError($('.problem-error', card), error);
  }

  async function submitFile(problemId, card) {
    const input = $('.file-input', card);
    const file = input.files[0];
    if (!file) return;
    const revision = state.revision;
    const button = $('.submit-button', card);
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    $('span', button).textContent = '提交中…';
    input.disabled = true;
    setError($('.problem-error', card));
    try {
      const content = await readSourceFile(file);
      if (!content.trim()) throw new Error('源代码不能只包含空白字符。');
      if (new TextEncoder().encode(content).byteLength > maxFileSize) {
        throw new Error('源代码转换为 UTF-8 后超过 1 MB，请精简文件后重试。');
      }
      const result = await api(`/api/submissions/${encodeURIComponent(problemId)}`, {
        method: 'POST', body: JSON.stringify({ fileName: file.name, content }),
      });
      if (revision !== state.revision) return;
      state.session.submissions[problemId] = result.submission;
      renderSubmission(card, result.submission);
      input.value = '';
      selectFile(card);
      showToast(`${problemId} 题提交成功，可点击“查看代码”核对。`);
    } catch (error) {
      if (revision === state.revision) setError($('.problem-error', card), error.message);
    } finally {
      button.removeAttribute('aria-busy');
      $('span', button).textContent = '提交';
      input.disabled = state.session?.exam.status !== 'ongoing';
      button.disabled = !input.files[0] || input.disabled;
    }
  }

  async function viewCode(problemId, card) {
    const button = $('.view-button', card);
    const revision = state.revision;
    button.disabled = true;
    setError($('.problem-error', card));
    try {
      const submission = await api(`/api/submissions/${encodeURIComponent(problemId)}`);
      if (revision !== state.revision) return;
      $('#code-title').textContent = submission.fileName;
      $('#code-content').textContent = submission.content;
      openDialog(codeDialog, button);
    } catch (error) {
      if (revision === state.revision) setError($('.problem-error', card), error.message);
    } finally { button.disabled = false; }
  }

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = $('#username');
    const password = $('#password');
    const validUsername = /^[A-Za-z0-9-]{4,20}$/.test(username.value);
    const validPassword = password.value.length >= 6 && password.value.length <= 32;
    username.setAttribute('aria-invalid', String(!validUsername));
    password.setAttribute('aria-invalid', String(!validPassword));
    if (!validUsername || !validPassword) {
      setError($('#login-error'), !validUsername ? '用户名须为4-20位字母、数字或连字符，例如 LN-0001。' : '请输入6-32位密码。');
      (!validUsername ? username : password).focus();
      return;
    }
    const button = $('#login-button');
    button.disabled = true;
    button.textContent = '正在登录…';
    setError($('#login-error'));
    try {
      const session = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: username.value, password: password.value }) });
      showExam(session);
      $('#account-toggle').focus();
    } catch (error) { setError($('#login-error'), error.message); }
    finally { button.disabled = false; button.textContent = '登录'; }
  });

  for (const input of [$('#username'), $('#password')]) {
    input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); setError($('#login-error')); });
  }

  $('#account-toggle').addEventListener('click', () => {
    const isOpen = !$('#account-menu').hidden;
    $('#account-menu').hidden = isOpen;
    $('#account-toggle').setAttribute('aria-expanded', String(!isOpen));
  });
  document.addEventListener('click', (event) => { if (!$('#account').contains(event.target)) closeAccountMenu(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#account-menu').hidden) { closeAccountMenu(); $('#account-toggle').focus(); }
  });
  $('#logout-button').addEventListener('click', async () => {
    const button = $('#logout-button');
    button.disabled = true;
    try {
      await api('/api/logout', { method: 'POST' });
      showLogin();
      $('#username').focus();
    } catch (error) { showToast(error.message); }
    finally { button.disabled = false; }
  });

  $('#download-button').addEventListener('click', async () => {
    const button = $('#download-button');
    const revision = state.revision;
    button.disabled = true;
    button.textContent = '下载中…';
    try {
      const response = await fetch('/api/exam/download', { credentials: 'same-origin' });
      if (response.status === 401) { showLogin('登录已过期，请重新登录。'); return; }
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || '下载失败，请稍后重试。');
      }
      const blob = await response.blob();
      if (revision !== state.revision) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'day1.zip';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      $('#message-text').textContent = '下载已开始，请在浏览器下载中心查看进度。';
      openDialog(messageDialog, button);
    } catch (error) { showToast(error.message || '下载失败，请检查网络后重试。'); }
    finally { button.disabled = false; button.textContent = '下载'; }
  });

  for (const button of codeDialog.querySelectorAll('.close-dialog')) button.addEventListener('click', () => codeDialog.close());
  $('.button', messageDialog).addEventListener('click', () => messageDialog.close());
  for (const dialog of [codeDialog, messageDialog]) {
    dialog.addEventListener('close', () => {
      const trigger = dialogTriggers.get(dialog);
      if (trigger?.isConnected && !trigger.disabled && trigger.getClientRects().length) trigger.focus();
    });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  }

  async function restoreSession() {
    try {
      const session = await api('/api/session');
      if (session.authenticated) showExam(session);
      else showLogin();
    } catch (error) { showLogin(error.message); }
  }
  window.addEventListener('pageshow', (event) => { if (event.persisted) restoreSession(); });
  restoreSession();
})();
