// Checks the auto-call setup without placing a call or printing secrets: Twilio keys, account type and balance,
// the TWILIO_FROM number, verified numbers (trial), Azure speech, and whether APP_URL reaches this API from the internet.
// Usage: npm.cmd run app:check-calling   (the API must be running for the APP_URL check)
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const ok = (good, label, detail = '') => console.log(`${good ? 'OK  ' : 'FIX '} ${label}${detail ? `: ${detail}` : ''}`);
const mask = (n) => `${n.slice(0, 5)}…${n.slice(-3)}`;
const sid = env.TWILIO_ACCOUNT_SID, from = env.TWILIO_FROM ?? '';

if (!sid || !env.TWILIO_AUTH_TOKEN || !from) {
  ok(false, 'Twilio', 'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM must all be set in .env (until then the app is in test mode)');
} else {
  const auth = { authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}` };
  const get = async (path) => { const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, { headers: auth }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const acc = await get('.json');
  ok(acc.status === 200, 'Twilio keys', acc.status === 200 ? `account ${acc.body.status}, ${acc.body.type}` : `rejected (${acc.status}): check SID and Auth Token`);
  if (acc.status === 200) {
    const bal = await get('/Balance.json');
    if (bal.status === 200) ok(Number(bal.body.balance) > 0, 'Twilio balance', `${bal.body.balance} ${bal.body.currency}${Number(bal.body.balance) > 0 ? '' : ': add funds (Console → Billing), calls cannot be paid for'}`);
    const own = (await get(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(from)}`)).body.incoming_phone_numbers?.[0];
    const verifiedFrom = own ? null : (await get(`/OutgoingCallerIds.json?PhoneNumber=${encodeURIComponent(from)}`)).body.outgoing_caller_ids?.[0];
    ok(!!(own?.capabilities?.voice || verifiedFrom), 'TWILIO_FROM', own ? `${mask(from)} is your Twilio number (voice: ${own.capabilities?.voice})`
      : verifiedFrom ? `${mask(from)} is a verified caller ID` : `${mask(from)} is not on this account: buy a voice number (Console → Phone Numbers → Buy a number) and put it in TWILIO_FROM`);
    if (acc.body.type === 'Trial') {
      const ids = ((await get('/OutgoingCallerIds.json?PageSize=100')).body.outgoing_caller_ids ?? []).filter((x) => x.phone_number.startsWith('+880'));
      ok(ids.length > 0, 'Trial: verified Bangladeshi numbers', ids.length ? ids.map((x) => mask(x.phone_number)).join(', ') + ' (a trial can call only these)' : 'none: add your BD mobile under Console → Phone Numbers → Verified Caller IDs');
    }
    console.log('     Also check by hand: Console → Voice → Settings → Geo permissions → Bangladesh ticked (not readable on trial accounts).');
  }
}

if (env.AZURE_SPEECH_KEY) ok(!!env.AZURE_SPEECH_REGION, 'Azure speech', env.AZURE_SPEECH_REGION ? `key set, region ${env.AZURE_SPEECH_REGION}` : 'key set but AZURE_SPEECH_REGION is missing');
else console.log("OPT  Azure speech: not set, calls use Twilio's Bengali (India) voice; add AZURE_SPEECH_KEY for the Bangladeshi voices");

if (!env.APP_URL) ok(false, 'APP_URL', 'not set: run npm.cmd run app:tunnel, then restart the API');
else {
  // the audio route answers 404 for an unknown file: any 404 from it proves the address reaches this API
  const r = await fetch(`${env.APP_URL.replace(/\/$/, '')}/api/voice/audio/00000000000000000000000000000000`, { signal: AbortSignal.timeout(10000) }).catch((e) => ({ status: 0, err: e }));
  ok(r.status === 404, 'APP_URL reachable from the internet', r.status === 404 ? env.APP_URL
    : `${env.APP_URL} does not reach the API (${r.status || 'no answer'}): run npm.cmd run app:tunnel (it changes the address), then restart the API`);
}
