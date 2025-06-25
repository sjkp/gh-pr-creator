/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

interface Env {
	GITHUB_TOKEN: string;
	BREVO_API_KEY: string;
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/patch" && request.method === "POST") {
			try {
				const userEmail = request.headers.get("x-user-email");
				if (!userEmail) {
					return new Response("Missing x-user-email header", { status: 400 });
				}
				const body = await request.json() as Record<string, any>;
				const patchId = Object.keys(body)[0];
				const patchData = body[patchId];
				const timestamp = Date.now();
				const branch = `${patchId}-${timestamp}`;

				const owner = "sjkp";
				const repo = "plejehjem-info";
				const filePath = "src/data/patches.json";
				const githubToken = (env as Env).GITHUB_TOKEN;
				if (!githubToken) {
					return new Response("Missing GITHUB_TOKEN", { status: 500 });
				}

				// 1. Get the current patches.json from the repo
				const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
					headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "cf-worker" },
				});
				if (!getRes.ok) {
					return new Response(`Failed to fetch patches.json: ${getRes.statusText}`, { status: 500 });
				}
				const fileData = await getRes.json() as { content: string; sha: string };
				const content = atob(fileData.content.replace(/\n/g, ""));
				const json = JSON.parse(content);

				// 2. Patch the JSON
				json[patchId] = patchData;
				const newContent = btoa(JSON.stringify(json, null, 4));

				// 3. Create a new branch from main
				const mainRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/main`, {
					headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "cf-worker" },
				});
				if (!mainRefRes.ok) {
					return new Response(`Failed to get main ref: ${mainRefRes.statusText}`, { status: 500 });
				}
				const mainRef = await mainRefRes.json() as { object: { sha: string } };
				const sha = mainRef.object.sha;

				const createRefRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
					method: "POST",
					headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "cf-worker", "Content-Type": "application/json" },
					body: JSON.stringify({
						ref: `refs/heads/${branch}`,
						sha,
					}),
				});
				if (!createRefRes.ok) {
					return new Response(`Failed to create branch: ${createRefRes.statusText}`, { status: 500 });
				}

				// 4. Update patches.json in the new branch
				const updateRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
					method: "PUT",
					headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "cf-worker", "Content-Type": "application/json" },
					body: JSON.stringify({
						message: `patch: update ${patchId}`,
						content: newContent,
						branch,
						sha: fileData.sha,
					}),
				});
				if (!updateRes.ok) {
					return new Response(`Failed to update patches.json: ${updateRes.statusText}`, { status: 500 });
				}

				// 5. Create a PR
				const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
					method: "POST",
					headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "cf-worker", "Content-Type": "application/json" },
					body: JSON.stringify({
						title: `patch: update ${patchId}`,
						head: branch,
						base: "main",
						body: `Automated patch for ${patchId} from ${userEmail}`,
					}),
				});
				if (!prRes.ok) {
					return new Response(`Failed to create PR: ${prRes.statusText}`, { status: 500 });
				}
				const pr = await prRes.json() as { html_url: string; number: number; head: { sha: string } };

				// Send email via Brevo
				const brevoApiKey = (env as Env).BREVO_API_KEY;
				if (!brevoApiKey) {
					return new Response("Missing BREVO_API_KEY", { status: 500 });
				}
				const prNumber = pr.number;
				const commitId = pr.head.sha;
				const verifyUrl = `https://patch.plejehjem.info/verify/${prNumber}/${commitId}`;
				let patchInfoHtml = "";
				if (patchData && typeof patchData === "object" && !Array.isArray(patchData)) {
					patchInfoHtml = '<ul>' + Object.entries(patchData).map(([key, value]) => `<li><strong>${key}:</strong> ${String(value)}</li>`).join('') + '</ul>';
				} else {
					patchInfoHtml = `<p>${String(patchData)}</p>`;
				}
				const emailPayload = {
					sender: { name: "Simon J.K. Pedersen", email: "sjkp@plejehjem.info" },
					to: [{ email: userEmail }],
					subject: `Bekræft plejehjem rettelse (${prNumber})`,
					htmlContent: `<h3>Tak for din rettelse!</h3><p>Klik på følgende link for at bekræfte rettelsen:</p><p><a href=\"${verifyUrl}\">${verifyUrl}</a></p><h3>Detaljer om rettelsen:</h3>${patchInfoHtml}`
				};
				await fetch("https://api.brevo.com/v3/smtp/email", {
					method: "POST",
					headers: {
						"api-key": brevoApiKey,
						"Content-Type": "application/json",
						"Accept": "application/json"
					},
					body: JSON.stringify(emailPayload)
				});
				return Response.json({ url: pr.html_url });
			} catch (err) {
				return new Response(`Error: ${err}`, { status: 500 });
			}
		}
		// /verify/:prNumber/:commitId endpoint
		const verifyMatch = url.pathname.match(/^\/verify\/(\d+)\/([a-fA-F0-9]+)$/);
		if (verifyMatch && request.method === "GET") {
			const prNumber = verifyMatch[1];
			const commitId = verifyMatch[2];
			const owner = "sjkp";
			const repo = "plejehjem-info";
			const githubToken = (env as Env).GITHUB_TOKEN;
			if (!githubToken) {
				return new Response("Missing GITHUB_TOKEN", { status: 500 });
			}
			// Get PR info to verify commit_id
			const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
				headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "cf-worker" },
			});
			if (!prRes.ok) {
				return new Response(`Failed to fetch PR: ${prRes.statusText}`, { status: 404 });
			}
			const pr = await prRes.json() as { head: { sha: string } };
			if (pr.head.sha !== commitId) {
				return new Response("Invalid commit id for this PR", { status: 400 });
			}
			// Post a comment to the PR
			const commentRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
				method: "POST",
				headers: { Authorization: `Bearer ${githubToken}`, "User-Agent": "cf-worker", "Content-Type": "application/json" },
				body: JSON.stringify({ body: "email verified" })
			});
			if (!commentRes.ok) {
				return new Response(`Failed to post comment: ${commentRes.statusText}`, { status: 500 });
			}
			return Response.redirect("https://plejehjem.info/rettelse-behandles", 302);
		}
		return new Response('Hello World!');
	},
} satisfies ExportedHandler<Env>;
