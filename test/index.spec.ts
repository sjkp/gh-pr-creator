import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// Add local Env type for test
interface Env {
	GITHUB_TOKEN: string;
}

describe('PATCH endpoint', () => {
	it('creates a PR and returns the PR URL', async () => {
		// Mock fetch for GitHub API calls
		const patchId = '24189765';
		const patchData = {
			"Plejehjemsleder": "Tina Agergaard Hansen",
			"E-mail": "TIAG@billund.dk",
			"Phone": "24 46 36 83"
		};
		const body = { [patchId]: patchData };

		let call = 0;
		// Patch global fetch to return Response objects
		globalThis.fetch = async (url, options) => {
			call++;
			if (url.toString().includes('/contents/main/src/data/patches.json') && !options?.method) {
				// GET patches.json
				return new Response(JSON.stringify({ content: btoa(JSON.stringify({})), sha: 'sha123' }), { status: 200 });
			}
			if (url.toString().includes('/git/refs/heads/main')) {
				// Get main branch ref
				return new Response(JSON.stringify({ object: { sha: 'mainsha' } }), { status: 200 });
			}
			if (url.toString().includes('/git/refs') && options?.method === 'POST') {
				// Create branch
				return new Response('{}', { status: 201 });
			}
			if (url.toString().includes('/contents/main/src/data/patches.json') && options?.method === 'PUT') {
				// Update patches.json
				return new Response('{}', { status: 200 });
			}
			if (url.toString().includes('/pulls') && options?.method === 'POST') {
				// Create PR
				return new Response(JSON.stringify({ html_url: 'https://github.com/sjkp/plejehjem-info/pull/1' }), { status: 201 });
			}
			return new Response('{}', { status: 404, statusText: 'Not found' });
		};

		const req = new Request('http://example.com/patch', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		const ctx = createExecutionContext();
		const testEnv: Env = { GITHUB_TOKEN: 'test' };
		const response = await worker.fetch(req, testEnv, ctx);
		await waitOnExecutionContext(ctx);
		const json = await response.json() as { url: string };
		expect(json.url).toBe('https://github.com/sjkp/plejehjem-info/pull/1');
	});
});
