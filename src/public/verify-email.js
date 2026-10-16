(() => {
  const $ = (id) => document.getElementById(id);
  const views = ['loading', 'form-state', 'success-state', 'error-state'];
  const show = (id) => views.forEach((view) => $(view).classList.toggle('hidden', view !== id));
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  let username = '';
  async function api(path, body) {
    const response = await fetch(`/api/auth/owner/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.message || 'Something went wrong. Please try again.'), { code: result.errorCode });
    return result.data;
  }
  function fail(error) {
    const expired = error.code === 'LINK_EXPIRED';
    const used = error.code === 'LINK_USED';
    $('error-title').textContent = expired ? 'This link has expired' : used ? 'This link was already used' : 'This link can’t be used';
    $('error-message').textContent = expired ? 'Verification links last 24 hours. Request a fresh email to finish setting up your account.' : used ? 'If your account is already active, return to the app and sign in. Otherwise, request a new email.' : 'Check that you opened the full link, or request a new verification email.';
    $('identifier').value = username;
    show('error-state');
  }
  if (!token) fail({ code: 'LINK_INVALID' });
  else api('verification-link/validate', { token }).then((data) => {
    username = data.username;
    $('username').textContent = username;
    show('form-state');
  }).catch(fail);
  document.querySelectorAll('.visibility').forEach((button) => button.addEventListener('click', () => {
    const input = $(button.dataset.target);
    input.type = input.type === 'password' ? 'text' : 'password';
    button.textContent = input.type === 'password' ? 'Show' : 'Hide';
    button.setAttribute('aria-label', `${button.textContent} password`);
  }));
  function validate() {
    const password = $('password').value;
    const confirm = $('confirm').value;
    const longEnough = password.length >= 12 && password.length <= 128;
    const matches = !!confirm && password === confirm;
    $('password-rule').textContent = longEnough ? 'Password length looks good.' : 'Use at least 12 characters.';
    $('password-rule').className = `hint ${password && !longEnough ? 'bad' : longEnough ? 'good' : ''}`;
    $('confirm-rule').textContent = matches ? 'Passwords match.' : 'Passwords must match.';
    $('confirm-rule').className = `hint ${confirm && !matches ? 'bad' : matches ? 'good' : ''}`;
    $('complete').disabled = !longEnough || !matches;
  }
  $('password').addEventListener('input', validate);
  $('confirm').addEventListener('input', validate);
  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    validate();
    if ($('complete').disabled) return;
    $('complete').disabled = true;
    $('complete').firstChild.textContent = 'Verifying your account… ';
    $('form-error').classList.add('hidden');
    try {
      const data = await api('verification-link/complete', { token, password: $('password').value });
      $('success-username').textContent = data.username;
      history.replaceState(null, '', location.pathname);
      show('success-state');
    } catch (error) {
      if (['LINK_EXPIRED', 'LINK_USED', 'LINK_INVALID'].includes(error.code)) fail(error);
      else { $('form-error').textContent = error.message; $('form-error').classList.remove('hidden'); }
    } finally { $('complete').firstChild.textContent = 'Verify account & set password '; validate(); }
  });
  $('resend-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const identifier = $('identifier').value.trim();
    if (!identifier) return;
    $('resend').disabled = true;
    $('resend-message').textContent = 'Sending…';
    try {
      await api('resend-code', { identifier });
      $('resend-message').textContent = 'If registration is pending, a fresh link and code are on their way. Check your inbox.';
    } catch (error) { $('resend-message').textContent = error.message; }
    finally { $('resend').disabled = false; }
  });
})();
