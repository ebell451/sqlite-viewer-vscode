import * as vsc from 'vscode';
import * as jose from 'jose';
import TelemetryReporter from '@vscode/extension-telemetry';
import { AccessToken, JWTPublicKeySPKI, LicenseKey } from './constants';
import { activateProviders } from './extension';
import { getShortMachineId } from './util';

const licenseKeyRegex = /[A-Z0-9]{8}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{12}/i;
const legacyLicenseKeyRegex = /[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}-[A-Z0-9]{8}/i;

export async function enterLicenseKeyCommand(context: vsc.ExtensionContext, reporter: TelemetryReporter) {
  const licenseKey = await vsc.window.showInputBox({
    prompt: 'Enter License Key',
    placeHolder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
    password: false,
    ignoreFocusOut: true,
    validateInput: (value) => {
      return licenseKeyRegex.test(value) || legacyLicenseKeyRegex.test(value) ? null : 'License key must be in the format XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX';
    },
  });
  if (!licenseKey) return;
  if (!licenseKeyRegex.test(licenseKey) && !legacyLicenseKeyRegex.test(licenseKey)) throw Error('Invalid license key format');

  const shortMachineId = await getShortMachineId();

  let response;
  try {
    const baseURL = context.extensionMode === vsc.ExtensionMode.Development ? 'http://localhost:8788' : 'https://vscode.sqliteviewer.app';
    response = await fetch(new URL('/api/register', baseURL), {
      method: 'POST',
      headers: [['Content-Type', 'application/x-www-form-urlencoded']],
      body: new URLSearchParams({ 'machine_id': shortMachineId, 'license_key': licenseKey }),
    });
  } catch {
    throw Error('No response from license validation service');
  }

  const contentType = response.headers.get('Content-Type');
  if (!response.ok || contentType?.includes('application/json') === false) {
    const message = contentType?.includes('text/plain') ? await response.text() : response.status.toString();
    throw Error(`License validation request failed: ${message}`);
  }

  let data;
  try {
    data = await response.json() as { token: string };
  } catch {
    throw Error('Failed to parse response');
  }
				
  const payload = jose.decodeJwt(data.token);
  // if (!payload) throw Error('Invalid access token');
  // if (payload.mid !== shortMachineId) {
  //   throw Error('Machine ID in token does not match this device, this should never happen!');
  // }

  await Promise.all([
    context.globalState.update(LicenseKey, licenseKey),
    context.globalState.update(AccessToken, data.token),
  ]);
  await activateProviders(context, reporter);

  vsc.window.showInformationMessage(`Thank you for purchasing SQLite Viewer PRO${payload.ent ? ' Business Edition' : ''}!`, {
    modal: true, 
    detail: 'Exclusive PRO features will be unlocked once you open the next file.'
  });
}

export async function enterAccessTokenCommand(context: vsc.ExtensionContext, reporter: TelemetryReporter) {
  const baseURL = context.extensionMode === vsc.ExtensionMode.Development ? 'http://localhost:8788' : 'https://vscode.sqliteviewer.app';

  const answer1 = await vsc.window.showInformationMessage('SQLite Viewer PRO Offline Activation', {
    modal: true, 
    detail: `This setup will activate the PRO version of SQLite Viewer without connecting to the license service directly.\nThis is intended for Business Edition customers who have purchased a license for offline use. PRO customers can use it to gain 14 days of offline use (same as regular activation).`,
  }, ...[{ title: 'Continue', value: true }]);
  if (answer1?.value !== true) return;

  const shortMachineId = await getShortMachineId();
  const registerHref = new URL(`/api/register?id=${shortMachineId}`, baseURL).href;

  const answer2 = await vsc.window.showInformationMessage('Out-of-Band Activation', {
    modal: true, 
    detail: `On any device with an active internet connection, open\n\n${registerHref}\n\nDo you want to open it on this device or copy it to the clipboard?`
  }, ...[{ title: 'Open', value: 'open' }, { title: 'Copy', value: 'copy' }] as const);

  if (answer2?.value === 'open')
    await vsc.env.openExternal(vsc.Uri.parse(registerHref));
  else if (answer2?.value === 'copy')
    await vsc.env.clipboard.writeText(registerHref);

  const jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/;
  const accessToken = await Promise.resolve(vsc.window.showInputBox({
    prompt: 'Enter access token generated on the website',
    placeHolder: 'eyJhbGciOiJFUzI1NiJ9.eyJ…',
    password: false,
    ignoreFocusOut: true,
    validateInput: (value) => {
      return jwtRegex.test(value) ? null : 'Access token must be a JWT';
    },
  }));
  if (!accessToken) throw Error('No access token');
  if (!jwtRegex.test(accessToken)) throw Error('Invalid access token format');

  let payload;
  try {
    payload = await verifyToken<Payload>(accessToken);
  } catch (err) {
    throw Error('Invalid access token', { cause: err });
  }
  if (!payload) throw Error('Invalid access token');
  // if (payload.mid !== shortMachineId) {
  //   throw Error('Machine ID in token does not match this device. Was the token generated by <https://vscode.sqliteviewer.app/api/register>?');
  // }
  if (!payload.ent && (!payload.key && !payload.licenseKey)) {
    throw Error('Token does not contain license key. Was it generated by <https://vscode.sqliteviewer.app/api/register>?'); 
  }

  await Promise.all([
    !payload.ent ? context.globalState.update(LicenseKey, payload.key || payload.licenseKey) : null,
    context.globalState.update(AccessToken, accessToken),
  ]);
  await activateProviders(context, reporter);

  vsc.window.showInformationMessage(`Thank you for purchasing SQLite Viewer PRO${payload.ent ? ' Business Edition' : ''}!`, {
    modal: true, 
    detail: 'Exclusive PRO features will be unlocked once you open the next file.'
  });
}

export async function deleteLicenseKeyCommand(context: vsc.ExtensionContext, reporter: TelemetryReporter) {
  await Promise.all([
    context.globalState.update(LicenseKey, ''),
    context.globalState.update(AccessToken, ''),
  ]);
  await activateProviders(context, reporter);

  vsc.window.showInformationMessage('The license was deactivated for this device!', {
    modal: true, 
    detail: 'SQLite Viewer PRO will be deactivated once you open the next file.'
  });
}

function calcDaysSinceIssued(issuedAt: number) {
  const currentTime = Date.now() / 1000;
  const diffSeconds = currentTime - issuedAt;
  const diffDays = diffSeconds / (24 * 60 * 60);
  return diffDays;
}

export async function refreshAccessToken(context: vsc.ExtensionContext, licenseKey: string, accessToken?: string) {
  let response;
  try {
    const baseURL = context.extensionMode === vsc.ExtensionMode.Development ? 'http://localhost:8788' : 'https://vscode.sqliteviewer.app';

    const payload = accessToken != null ? jose.decodeJwt(accessToken) : null;
    if (payload && 'ent' in payload) return accessToken;

    const daysSinceIssued = accessToken && payload?.iat && calcDaysSinceIssued(payload.iat);
    // console.log({ daysSinceIssued })
    if (!daysSinceIssued || daysSinceIssued > 14) {
      response = await fetch(new URL('/api/register', baseURL), {
        method: 'POST',
        headers: [['Content-Type', 'application/x-www-form-urlencoded']],
        body: new URLSearchParams({ 'machine_id': await getShortMachineId(), 'license_key': licenseKey }),
      });
    } else if (daysSinceIssued > 1) {
      response = await fetch(new URL('/api/refresh', baseURL), {
        method: 'POST',
        headers: [['Content-Type', 'application/x-www-form-urlencoded']],
        body: new URLSearchParams({ 'machine_id': await getShortMachineId(), 'license_key': licenseKey, 'access_token': accessToken }),
      });
    } else {
      return accessToken;
    }
  } catch {
    throw new Error('No response from license validation service');
  }

  if (!response.ok || response.headers.get('Content-Type')?.includes('application/json') === false) {
    response.text().then(console.error).catch();
    throw new Error(`License validation request failed: ${response.status}`);
  }

  let data;
  try {
    data = await response.json() as { token: string };
  } catch {
    throw new Error('Failed to parse response');
  }

  // const freshPayload = jose.decodeJwt(data.token);
  // if (!freshPayload) throw Error('Invalid access token');
  // if (freshPayload.mid !== await getShortMachineId()) {
  //   throw Error('Machine ID in token does not match this device, this should never happen!');
  // }

  // console.log(data);
  Promise.resolve(context.globalState.update(AccessToken, data.token)).catch(console.warn);
  return data.token;
}

export async function verifyToken<PayloadType = jose.JWTPayload>(accessToken: string): Promise<PayloadType & jose.JWTPayload|null> {
  try {
    const jwtKey = await jose.importSPKI(JWTPublicKeySPKI, 'ES256');
    const { payload } = await jose.jwtVerify<PayloadType>(accessToken, jwtKey);
    return payload;
  } catch {
    return null;
  }
}

type Payload = { mid: string, key?: string, licenseKey?: string, ent?: 1 }
