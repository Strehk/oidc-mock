import { userLabel, type MockConfig } from './config.js';

export function escapeHtml(value: unknown) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}

const styles = /* css */ `
:root {
	--bg: #f4f5f7; --card: #fff; --text: #1d2330; --muted: #667085; --border: #dde1e8;
	--accent: #2f5bea; --accent-text: #fff; --hover: #eef2ff; --error-bg: #fdecec; --error: #b42318;
	--code: #f1f3f6;
	color-scheme: light;
}
@media (prefers-color-scheme: dark) {
	:root {
		--bg: #12151b; --card: #1b1f27; --text: #e6e9ef; --muted: #98a2b3; --border: #2c323d;
		--accent: #7c9cff; --accent-text: #0b1020; --hover: #232a38; --error-bg: #3a1a1a; --error: #ffb4ab;
		--code: #151920;
		color-scheme: dark;
	}
}
* { box-sizing: border-box; }
body {
	margin: 0; min-height: 100vh; background: var(--bg); color: var(--text);
	font: 15px/1.45 system-ui, -apple-system, 'Segoe UI', sans-serif;
	display: flex; justify-content: center; align-items: flex-start; padding: 48px 16px;
}
main { width: 100%; max-width: 440px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 24px; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { color: var(--muted); font-size: 13px; margin: 0 0 20px; word-break: break-all; }
.meta code { font-size: 12px; }
.users { display: grid; gap: 8px; }
.user { display: flex; align-items: stretch; gap: 6px; }
.user button[name=sub] {
	flex: 1; text-align: left; padding: 10px 14px; border-radius: 10px; cursor: pointer;
	border: 1px solid var(--border); background: transparent; color: inherit; font: inherit;
}
.user button[name=sub]:hover, .user button[name=sub]:focus-visible { background: var(--hover); border-color: var(--accent); outline: none; }
.user small { display: block; color: var(--muted); font-size: 13px; }
.edit {
	width: 40px; border-radius: 10px; border: 1px solid var(--border); background: transparent;
	color: var(--muted); cursor: pointer; font-size: 16px;
}
.edit:hover { color: var(--text); background: var(--hover); }
details { margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px; }
summary { cursor: pointer; color: var(--muted); font-size: 14px; }
label { display: block; font-size: 13px; color: var(--muted); margin: 14px 0 4px; }
input[type=text], textarea {
	width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border);
	background: var(--code); color: inherit; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
textarea { min-height: 220px; resize: vertical; }
.primary {
	margin-top: 12px; width: 100%; padding: 10px; border: 0; border-radius: 10px; cursor: pointer;
	background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600;
}
.cancel { display: inline-block; margin-top: 16px; color: var(--muted); font-size: 13px; }
.error { background: var(--error-bg); color: var(--error); padding: 10px 12px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
.empty { color: var(--muted); font-size: 14px; }
`;

function layout(title: string, body: string) {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
</head>
<body><main><div class="card">${body}</div></main></body>
</html>`;
}

export function loginPage({
	config,
	params,
	error,
	customSub,
	customClaims
}: {
	config: MockConfig;
	params: Record<string, string>;
	error?: string;
	customSub?: string;
	customClaims?: string;
}) {
	const hidden = `<input type="hidden" name="params" value="${escapeHtml(JSON.stringify(params))}">`;
	const cancel = new URL(params.redirect_uri!);
	cancel.searchParams.set('error', 'access_denied');
	if (params.state) cancel.searchParams.set('state', params.state);

	const users = config.users.length
		? config.users
				.map(
					(user) => `<div class="user">
	<button type="submit" name="sub" value="${escapeHtml(user.sub)}">
		${escapeHtml(userLabel(user))}
		${user.description ? `<small>${escapeHtml(user.description)}</small>` : ''}
	</button>
	${
		config.custom_login
			? `<button type="button" class="edit" title="Edit claims before signing in" data-sub="${escapeHtml(user.sub)}" data-claims="${escapeHtml(JSON.stringify(user.claims, null, 2))}">✎</button>`
			: ''
	}
</div>`
				)
				.join('\n')
		: `<p class="empty">No users configured${config.file ? ` in <code>${escapeHtml(config.file)}</code>` : ''}.</p>`;

	const custom = config.custom_login
		? `<details${error || customClaims ? ' open' : ''}>
	<summary>Sign in with custom claims</summary>
	<form method="post">
		${hidden}
		<label for="custom_sub">sub</label>
		<input type="text" id="custom_sub" name="custom_sub" value="${escapeHtml(customSub ?? '')}" placeholder="any-subject" autocomplete="off">
		<label for="custom_claims">Claims (JSON object)</label>
		<textarea id="custom_claims" name="custom_claims" spellcheck="false" placeholder='{\n  "email": "someone@example.org"\n}'>${escapeHtml(customClaims ?? '')}</textarea>
		<button type="submit" class="primary" name="custom" value="1">Sign in</button>
	</form>
</details>
<script>
for (const button of document.querySelectorAll('.edit')) {
	button.addEventListener('click', () => {
		document.getElementById('custom_sub').value = button.dataset.sub;
		document.getElementById('custom_claims').value = button.dataset.claims;
		const details = document.querySelector('details');
		details.open = true;
		details.scrollIntoView({ behavior: 'smooth' });
		document.getElementById('custom_claims').focus();
	});
}
</script>`
		: '';

	return layout(
		'Sign in – oidc-mock',
		`<h1>Sign in</h1>
<p class="meta">Client <code>${escapeHtml(params.client_id)}</code> · returns to <code>${escapeHtml(cancel.origin)}</code></p>
${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
<form method="post" class="users">
	${hidden}
	${users}
</form>
${custom}
<a class="cancel" href="${escapeHtml(cancel.toString())}">Cancel</a>`
	);
}

export function messagePage(title: string, message: string) {
	return layout(`${title} – oidc-mock`, `<h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(message)}</p>`);
}
