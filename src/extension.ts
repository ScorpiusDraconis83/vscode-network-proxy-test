/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/// <reference path='vscode-proxy-agent.d.ts' />

import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as http2 from 'http2';
import * as net from 'net';
import * as tls from 'tls';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as dns from 'dns';
import * as util from 'util';
import * as undici from 'undici';
import type * as proxyAgentType from './vscode-proxy-agent';

const proxyAgent: typeof proxyAgentType | undefined = loadVSCodeModule<any>('@vscode/proxy-agent');

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.commands.registerCommand('network-proxy-test.test-connection', () => testConnection(false)));
	context.subscriptions.push(vscode.commands.registerCommand('network-proxy-test.test-connection-http2', () => testConnection(true)));
	context.subscriptions.push(vscode.commands.registerCommand('network-proxy-test.show-os-certificates', () => showOSCertificates()));
	context.subscriptions.push(vscode.commands.registerCommand('network-proxy-test.show-builtin-certificates', () => showBuiltInCertificates()));
}

async function testConnection(useHTTP2: boolean) {
	const url = await vscode.window.showInputBox({
		prompt: 'Enter URL to probe',
		value: 'https://example.com',
		ignoreFocusOut: true,
	});
	if (!url) {
		return;
	}

	const editor = await openEmptyEditor();
	await logHeaderInfo(editor);
	await logSettings(editor);
	await logEnvVariables(editor);
	await lookupHosts(editor, url);
	await probeUrl(editor, url, useHTTP2);
}

async function showOSCertificates() {
	const editor = await openEmptyEditor();
	await logHeaderInfo(editor);
	const certs = await loadSystemCertificates();
	await logCertificates(editor, `Certificates loaded from the OS (${osCertificateLocation()}):`, certs!);
}

function osCertificateLocation() {
	switch (process.platform) {
		case 'win32':
			return 'Manage Computer Certificates > Trusted Root Certification Authorities';
		case 'darwin':
			return `Keychain Access > Certificates > 'Several Keychains'`;
		case 'linux':
			return '/etc/ssl/certs/ca-certificates.crt or ca-bundle.crt';
		default:
			return 'location unknown';
	}
}

async function showBuiltInCertificates() {
	const editor = await openEmptyEditor();
	await logHeaderInfo(editor);
	await logCertificates(editor, 'Certificates built-in with Node.js:', tls.rootCertificates);
}

async function logCertificates(editor: vscode.TextEditor, title: string, certs: ReadonlyArray<string | { from: string[]; pem: string; cert: crypto.X509Certificate }>) {
	await appendText(editor, `${title}\n`);
	for (const cert of certs) {
		const current = typeof cert === 'string' ? tryParseCertificate(cert) : cert instanceof crypto.X509Certificate ? cert : cert.cert;
		if (!(current instanceof crypto.X509Certificate)) {
			await appendText(editor, `- Certificate parse error: ${(current as any)?.message || String(current)}\n`);
			await appendText(editor, `  Input:\n${cert}\n`);
			continue;
		}
		// await appendText(editor, `- Raw:\n${typeof cert === 'string' ? cert : cert.pem}\n`);
		await appendText(editor, `- Subject: ${current.subject.split('\n').join(' ')}${ typeof cert === 'object' && 'from' in cert ? ` (${cert.from.join(' and ')})` : ''}\n`);
		if (current.subjectAltName) {
			await appendText(editor, `  Subject alt: ${current.subjectAltName}\n`);
		}
		await appendText(editor, `  Validity: ${current.validFrom} - ${current.validTo}${isPast(current.validTo) ? ' (expired)' : ''}\n`);
		await appendText(editor, `  Fingerprint: ${current.fingerprint}\n`);
		await appendText(editor, `  Issuer: ${current.issuer.split('\n').join(' ')}\n`);
		if (current.keyUsage) {
			await appendText(editor, `  Key usage: ${current.keyUsage.join(', ')}\n`);
		}
		if (!current.ca) {
			await appendText(editor, `  Not a CA\n`);
		}
	}
}

async function openEmptyEditor() {
	const document = await vscode.workspace.openTextDocument({ language: 'text' });
	return await vscode.window.showTextDocument(document);
}

async function logHeaderInfo(editor: vscode.TextEditor) {
	await appendText(editor, `Note: Make sure to replace all sensitive information with dummy values before sharing this output.\n\n`);
	await logRuntimeInfo(editor);
}

async function logRuntimeInfo(editor: vscode.TextEditor) {
	const pkg = require('../package.json');
	const product = require(path.join(vscode.env.appRoot, 'product.json'));
	await appendText(editor, `VS Code ${vscode.version} (${product.commit || 'out-of-source'})\n`);
	await appendText(editor, `${pkg.displayName} ${pkg.version}\n`);
	await appendText(editor, `${os.platform()} ${os.release()} ${os.arch()}\n`);
	if (vscode.env.remoteName) {
		const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
		if (ext) {
			await appendText(editor, `Extension: ${vscode.ExtensionKind[ext.extensionKind]}\n`);
		}
		await appendText(editor, `Remote: ${vscode.env.remoteName}\n`);
	}
	await appendText(editor, `\n`);
}

async function lookupHosts(editor: vscode.TextEditor, url: string) {
	const host = new URL(url).hostname;
	const timeoutSeconds = 10;
	const dnsLookup = util.promisify(dns.lookup);
	await appendText(editor, `DNS:\n`);
	await appendText(editor, `- Servers: ${dns.getServers().join(', ')}\n`);
	await appendText(editor, `- Result Order: ${dns.getDefaultResultOrder()}\n`);
	await appendText(editor, `- Auto Select Family: ${net.getDefaultAutoSelectFamily()}\n`);
	await appendText(editor, `- Auto Select Family Attempt Timeout: ${net.getDefaultAutoSelectFamilyAttemptTimeout()}\n`);
	await appendText(editor, `- Lookup: `);
	const start = Date.now();
	try {
		const dnsResult = await Promise.race([dnsLookup(host, { all: true }), timeout(timeoutSeconds * 1000)]);
		if (dnsResult !== 'timeout') {
			await appendText(editor, `${dnsResult.map(({ address }) => address).join(', ')} (${Date.now() - start} ms)\n`);
		} else {
			await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
		}
	} catch (err: any) {
		await appendText(editor, `Error (${Date.now() - start} ms): ${collectErrorMessages(err)}\n`);
	}
	await appendText(editor, '\n');
}

async function probeUrl(editor: vscode.TextEditor, url: string, useHTTP2: boolean) {
	await probeProxy(editor, url);
	await probeUrlWithNodeModules(editor, url, true, useHTTP2);
	await probeUrlWithFetch(editor, url);
}

async function probeProxy(editor: vscode.TextEditor, url: string) {
	const timeoutSeconds = 10;
	let probeProxyURL: string | undefined;
	if ((proxyAgent as any)?.resolveProxyURL) {
		await appendText(editor, `Proxy:\n`);
		await appendText(editor, `- URL: `);
		const start = Date.now();
		try {
			const proxyURL = await Promise.race([(proxyAgent as any).resolveProxyURL(url), timeout(timeoutSeconds * 1000)]);
			if (proxyURL === 'timeout') {
				await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
			} else {
				await appendText(editor, `${proxyURL || 'None'} (${Date.now() - start} ms)\n`);
				probeProxyURL = proxyURL;
			}
		} catch (err) {
			await appendText(editor, `Error (${Date.now() - start} ms): ${collectErrorMessages(err)}\n`);
		}
	}
	if (proxyAgent?.loadSystemCertificates && probeProxyURL?.startsWith('https:')) {
		const tlsOrig: typeof tls | undefined = (tls as any).__vscodeOriginal;
		if (tlsOrig) {
			await appendText(editor, `- TLS: `);
			const osCertificates = await loadSystemCertificates();
			if (!osCertificates) {
				await appendText(editor, `(failed to load system certificates) `);
			}
			const start = Date.now();
			try {
				const result = await Promise.race([tlsConnect(tlsOrig, probeProxyURL, [...tls.rootCertificates, ...(osCertificates || [])]), timeout(timeoutSeconds * 1000)]);
				if (result !== 'timeout') {
					await appendText(editor, `${result} (${Date.now() - start} ms)\n`);
				} else {
					await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
				}
			} catch (err) {
				await appendText(editor, `Error (${Date.now() - start} ms): ${collectErrorMessages(err)}\n`);
			}
		}
	}
	if (probeProxyURL) {
		const httpx: typeof https | typeof http | undefined = probeProxyURL.startsWith('https:') ? (https as any).__vscodeOriginal : (http as any).__vscodeOriginal;
		if (httpx) {
			await appendText(editor, `- Connection: `);
			const start = Date.now();
			try {
				const result = await Promise.race([proxyConnect(httpx, probeProxyURL, url), timeout(timeoutSeconds * 1000)]);
				if (result !== 'timeout') {
					await appendText(editor, `${result} (${Date.now() - start} ms)\n`);
				} else {
					await appendText(editor, `timed out after ${timeoutSeconds} seconds\n`);
				}
			} catch (err) {
				await appendText(editor, `Error (${Date.now() - start} ms): ${collectErrorMessages(err)}\n`);
			}
		}
	}
	if ((proxyAgent as any)?.resolveProxyURL) {
		await appendText(editor, `\n`);
	}
}

async function probeUrlWithNodeModules(editor: vscode.TextEditor, url: string, rejectUnauthorized: boolean, useHTTP2: boolean) {
	await appendText(editor, `Sending${useHTTP2 ? ' HTTP2' : ''} GET request to ${url}${rejectUnauthorized ? '' : ' (allowing unauthorized)'}...\n`);
	try {
		const res = useHTTP2 ? await http2Get(url, rejectUnauthorized) : await httpGet(url, rejectUnauthorized);
		const cert = res.socket instanceof tls.TLSSocket ? (res.socket as tls.TLSSocket).getPeerCertificate(true) : undefined;
		await appendText(editor, `Received response:\n`);
		await appendText(editor, `- Status: ${res.statusCode} ${res.statusMessage}\n`);
		if (res.headers.location) {
			await appendText(editor, `- Location: ${res.headers.location}\n`);
		}
		if (res.statusCode === 407) {
			await appendText(editor, `- Proxy-Authenticate: ${res.headers['proxy-authenticate']}\n`);
		}
		if (cert) {
			await appendText(editor, `Certificate chain:\n`);
			let hasExpired = false;
			let current = cert;
			const seen = new Set<string>();
			while (!seen.has(current.fingerprint)) {
				seen.add(current.fingerprint);
				await appendText(editor, `- Subject: ${current.subject?.CN}${current.subject?.O ? ` (${current.subject.O})` : ''}\n`); // Subject can be undefined? https://github.com/microsoft/vscode-remote-release/issues/9212#issuecomment-1851917503
				if (current.subjectaltname) {
					await appendText(editor, `  Subject alt: ${current.subjectaltname}\n`);
				}
				const expired = isPast(current.valid_to);
				hasExpired = hasExpired || expired;
				await appendText(editor, `  Validity: ${current.valid_from} - ${current.valid_to}${expired ? ' (expired)' : ''}\n`);
				await appendText(editor, `  Fingerprint: ${current.fingerprint}\n`);
				if (current.issuerCertificate) {
					if (current.issuerCertificate.fingerprint512 === current.fingerprint512) {
						await appendText(editor, `  Self-signed\n`);
					}
					current = current.issuerCertificate;
				} else {
					await appendText(editor, `  Issuer certificate '${current.issuer.CN}${current.issuer.O ? ` (${current.issuer.O})` : ''}' not in certificate chain of the server.\n`);
				}
			}
			// await appendText(editor, `  Raw:\n${derToPem(cert.raw)}\n`);
			const uniqCerts = await getAllCaCertificates();
			const toVerify = new crypto.X509Certificate(current.raw);
			const toVerifyPublicKey = toVerify.publicKey.export({ type: 'spki', format: 'der' });
			const localRoots = uniqCerts.filter(({ cert }) => cert.publicKey.export({ type: 'spki', format: 'der' }).equals(toVerifyPublicKey) || toVerify.checkIssued(cert));
			if (localRoots.length) {
				const localRootsUnexpired = localRoots.filter(({ cert }) => !isPast(cert.validTo));
				const allRootsExpired = !localRootsUnexpired.length;
				await logCertificates(editor, `Local root certificates:`, localRoots);
				hasExpired = hasExpired || allRootsExpired;
			} else {
				// https://github.com/microsoft/vscode/issues/177139#issuecomment-1497180563
				await appendText(editor, `\nLast certificate not verified by OS root certificates. This might indicate an issue with the root certificates registered in your OS:\n`);
				await appendText(editor, `- Make sure that the root certificate for the certificate chain is registered as such in the OS. Use \`F1\` > \`Network Proxy Test: Show OS Certificates\` to see the list loaded by VS Code.\n`);
				await appendText(editor, `- Also make sure that your proxy and server return the complete certificate chain (except possibly for the root certificate).\n`);
			}
			if (hasExpired) {
				// https://github.com/microsoft/vscode-remote-release/issues/8207
				await appendText(editor, `\nOne or more certificates have expired. Update the expired certificates in the server's response and in your OS' certificate store (${osCertificateLocation()}).\n`);
			}
		}
		if (res.statusCode === 407) {
			// https://github.com/microsoft/vscode/issues/179450#issuecomment-1503397566
			await appendText(editor, `\nAuthentication with the proxy server failed. Proxy authentication isn't well supported yet. You could try setting the HTTP Proxy in VS Code's user settings to \`<http|https>://<username>:<password>@<proxy-server>\`. (\`F1\` > \`Preferences: Open User Settings\` > \`HTTP Proxy\`)\n`);
		}
	} catch (err) {
		await appendText(editor, `Received error: ${collectErrorMessages(err)}\n`);
		if (rejectUnauthorized && url.startsWith('https:')) {
			await appendText(editor, `Retrying while ignoring certificate issues to collect information on the certificate chain.\n\n`);
			await probeUrlWithNodeModules(editor, url, false, useHTTP2);
		}
	}
}

async function probeUrlWithFetch(editor: vscode.TextEditor, url: string) {
	const fetchImpls: { label: string; impl: typeof fetch | undefined }[] = [
		{
			label: 'Electron',
			impl: loadElectronFetch(),
		},
		{
			label: 'Node.js',
			impl: (globalThis as any).__vscodePatchedFetch || globalThis.fetch,
		},
		{
			label: 'Node.js (allow HTTP2)',
			impl: getNodeFetchWithH2(),
		},
	].filter(({ impl }) => !!impl);
	for (const { label, impl } of fetchImpls) {
		await appendText(editor, `\nSending GET request to ${url} using fetch from ${label}...\n`);
		try {
			const res = await impl!(url, { redirect: 'manual' });
			await appendText(editor, `Received response:\n`);
			await appendText(editor, `- Status: ${res.status} ${res.statusText}\n`);
			if (res.headers.has('location')) {
				await appendText(editor, `- Location: ${res.headers.get('location')}\n`);
			}
			if (res.status === 407) {
				await appendText(editor, `- Proxy-Authenticate: ${res.headers.get('proxy-authenticate')}\n`);
			}
		} catch (err) {
			await appendText(editor, `Received error: ${collectErrorMessages(err)}\n`);
		}
	}
}

function collectErrorMessages(e: any): string {
	// Collect error messages from nested errors as seen with Node's `fetch`.
	const seen = new Set<any>();
	function collect(e: any, indent: string): string {
		if (!e || typeof e !== 'object' || seen.has(e)) {
			return '';
		}
		seen.add(e);
		const message = e.message || e.code || e.toString?.() || '';
		return [
			message ? `${indent}${message}\n` : '',
			collect(e.cause, indent + '  '),
			...(Array.isArray(e.errors) ? e.errors.map((e: any) => collect(e, indent + '  ')) : []),
		].join('');
	}
	return collect(e, '')
		.trim();
}

function loadElectronFetch(): typeof fetch | undefined {
	try {
		return require('electron')?.net?.fetch;
	} catch (err) {
		// Not available.
	}
	return undefined;
}

function getNodeFetchWithH2(): typeof globalThis.fetch {
	const fetch = (globalThis as any).__vscodePatchedFetch || globalThis.fetch;
	return function (input: string | URL | globalThis.Request, init?: RequestInit) {
		return fetch(input, { dispatcher: new undici.Agent({ allowH2: true }), ...init });
	};
}

async function getAllCaCertificates() {
	const osCerts = await loadSystemCertificates();
	const certMap = new Map<string, { from: string[]; pem: string; cert: crypto.X509Certificate; }>();
	for (const pem of tls.rootCertificates) {
		const cert = tryParseCertificate(pem);
		if (cert instanceof crypto.X509Certificate) {
			certMap.set(cert.fingerprint512, { from: ['built-in'], pem, cert });
		}
	}
	if (osCerts) {
		for (const pem of osCerts) {
			const cert = tryParseCertificate(pem);
			if (cert instanceof crypto.X509Certificate) {
				if (certMap.has(cert.fingerprint512)) {
					certMap.get(cert.fingerprint512)!.from.push('OS');
				} else {
					certMap.set(cert.fingerprint512, { from: ['OS'], pem, cert });
				}
			}
		}
	}
	return [...certMap.values()];
}

function tryParseCertificate(pem: string) {
	try {
		return new crypto.X509Certificate(pem);
	} catch (err) {
		return err;
	}
}

async function httpGet(url: string, rejectUnauthorized: boolean) {
	return await new Promise<http.IncomingMessage>((resolve, reject) => {
		const httpx = url.startsWith('https:') ? https : http;
		const req = httpx.get(url, { rejectUnauthorized }, resolve);
		req.on('error', reject);
	});
}

async function http2Get(url: string, rejectUnauthorized: boolean) {
	return new Promise<{ socket: net.Socket | tls.TLSSocket, headers: NodeJS.Dict<string | string[]>, statusCode: number, statusMessage: string }>(async (resolve, reject) => {
		let socket: net.Socket | tls.TLSSocket;
		const client = http2.connect(url, {
			rejectUnauthorized,
		}, (_session, _socket) => {
			socket = _socket;
		});
		client.on('error', reject);

		const urlObj = new URL(url);
		const req = client.request({
			[http2.constants.HTTP2_HEADER_PATH]: urlObj.pathname,
		});

		req.on('response', (headers, _flags) => {
			const statusCode = headers[':status']!;
			const statusMessage = headers[':status-text'] || http.STATUS_CODES[statusCode] || 'Unknown';
			resolve({ socket, headers, statusCode, statusMessage: Array.isArray(statusMessage) ? statusMessage.join() : statusMessage });
			client.close();
		});
		req.end();
	});
}

const networkSettingsIds = [
	'http.proxy',
	'http.noProxy',
	'http.proxyAuthorization',
	'http.proxyStrictSSL',
	'http.proxySupport',
	'http.electronFetch',
	'http.fetchAdditionalSupport',
	'http.proxyKerberosServicePrincipal',
	'http.systemCertificates',
	'http.experimental.systemCertificatesV2',
];

async function logSettings(editor: vscode.TextEditor) {
	const conf = vscode.workspace.getConfiguration();
	const settings = networkSettingsIds.map(id => {
		const obj = conf.inspect<string>(id);
		const keys = Object.keys(obj || {})
			.filter(key => key !== 'key' && key !== 'defaultValue' && (obj as any)[key] !== undefined);
		return { id, obj, keys };
	}).filter(({ keys }) => keys.length);
	if (settings.length) {
		await appendText(editor, 'Settings:\n');
		for (const { id, obj, keys } of settings) {
			await appendText(editor, `- ${id}: ${conf.get<string>(id)}\n`);
			for (const key of keys) {
				await appendText(editor, `  - ${key}: ${(obj as any)[key]}\n`);
			}
		}
		await appendText(editor, '\n');
	}
}

async function logEnvVariables(editor: vscode.TextEditor) {
	const envVars = ['http_proxy', 'https_proxy', 'ftp_proxy', 'all_proxy', 'no_proxy'];
	const setEnvVars = [];
	for (const env in process.env) {
		if (envVars.includes(env.toLowerCase())) {
			setEnvVars.push(env);
		}
	}
	if (setEnvVars.length) {
		await appendText(editor, 'Environment variables:\n');
		for (const env of setEnvVars) {
			await appendText(editor, `${env}=${process.env[env]}\n`);
		}
		await appendText(editor, '\n');
	}
}

async function appendText(editor: vscode.TextEditor, string: string) {
	await editor.edit(builder => {
		builder.insert(editor.document.lineAt(editor.document.lineCount - 1).range.end, string);
	});
}

function timeout(ms: number) {
	return new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms));
}

function loadVSCodeModule<T>(moduleName: string): T | undefined {
	const appRoot = vscode.env.appRoot;
	try {
		return require(`${appRoot}/node_modules.asar/${moduleName}`);
	} catch (err) {
		// Not in ASAR.
	}
	try {
		return require(`${appRoot}/node_modules/${moduleName}`);
	} catch (err) {
		// Not available.
	}
	return undefined;
}

async function loadSystemCertificates(): Promise<string[] | undefined> {
	try {
		const certificates = await proxyAgent?.loadSystemCertificates({ log: console });
		return Array.isArray(certificates) ? certificates : undefined;
	} catch (err) {
		console.error(err);
		return undefined;
	}
}

async function tlsConnect(tlsOrig: typeof tls, proxyURL: string, ca: (string | Buffer)[]) {
	return new Promise<string>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyURL);
		const socket = tlsOrig.connect({
			host: proxyUrlObj.hostname,
			port: parseInt(proxyUrlObj.port, 10),
			servername: proxyUrlObj.hostname,
			ca,
		}, () => {
			socket.end();
			resolve('Succeeded');
		});
		socket.on('error', reject);
	});
}

async function proxyConnect(httpx: typeof https | typeof http, proxyUrl: string, targetUrl: string) {
	return new Promise<string>((resolve, reject) => {
		const proxyUrlObj = new URL(proxyUrl);
		const targetUrlObj = new URL(targetUrl);
		const targetHost = `${targetUrlObj.hostname}:${targetUrlObj.port || (targetUrlObj.protocol === 'https:' ? 443 : 80)}`;
		const options = {
			method: 'CONNECT',
			host: proxyUrlObj.hostname,
			port: proxyUrlObj.port,
			path: targetHost,
			headers: {
				Host: targetHost,
			},
			rejectUnauthorized: false,
		};
		const req = httpx.request(options);
		req.on('connect', (res, socket, head) => {
			const headers = ['proxy-authenticate', 'proxy-agent', 'server', 'via'].map(header => {
				return res.headers[header] ? `\n	${header}: ${res.headers[header]}` : undefined;
			}).filter(Boolean);
			socket.end();
			resolve(`${res.statusCode} ${res.statusMessage}${headers.join('')}`);
		});
		req.on('error', reject);
		req.end();
	});
}

function isPast(date: string) {
	const parsed = Date.parse(date);
	return !isNaN(parsed) && parsed < Date.now();
}
