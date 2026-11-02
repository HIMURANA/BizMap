# Auto-call setup (Bangla voice calls)

The app works without any of this in **test mode**: you can build campaigns, record your voice and press Launch,
but nobody is dialled. To place real calls you need three things: **Twilio** (dials the phones),
**Azure Speech** (Bangladeshi Bangla voice, optional) and a **public address** (so Twilio can reach your computer).

Everything below goes into `D:\Data\Data\.env`. The empty lines are already there; just fill them in.
After any change to `.env`, **restart the API**.

**In PowerShell type `npm.cmd`, not `npm`** (e.g. `npm.cmd run app:tunnel`): this PC blocks PowerShell scripts, which makes plain
`npm` fail with "running scripts is disabled on this system". In Command Prompt plain `npm` works.

**Check your setup at any time** (places no call, prints no secrets; the API must be running for the last line):

```
npm.cmd run app:check-calling
```

Every line should say `OK` (`OPT` = optional). Fix the `FIX` lines from top to bottom.

---

## 1. Twilio (required for real calls)

1. Sign up at https://www.twilio.com/try-twilio and verify your email and phone.
2. **Copy your keys.** Console home page → *Account Info*:
   - `Account SID` (starts with `AC`) → `TWILIO_ACCOUNT_SID=`
   - `Auth Token` (click *Show*) → `TWILIO_AUTH_TOKEN=`
3. **Allow calls to Bangladesh.** Console → *Voice* → *Settings* → *Geo permissions* → tick **Bangladesh** → *Save*.
   Without this every call fails with "permission to call this country".
4. **Get a number to call from.** Console → *Phone Numbers* → *Buy a number* → one with **Voice** capability
   (a US number is fine). Put it in E.164 form: `TWILIO_FROM=+1XXXXXXXXXX`.
5. **Trial account limits** (until you add a payment method / upgrade):
   - you can only call numbers you verified under *Phone Numbers → Verified Caller IDs* (add your own BD mobile there);
   - every call starts with an English "trial account" announcement and asks to press a key.
   Fine for testing; upgrade before real campaigns. Cost: see https://www.twilio.com/en-us/voice/pricing/bd.

```
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM=+1XXXXXXXXXX
```

## 2. Azure Speech (optional: Bangladeshi Bangla voices)

Without it, calls use Twilio's Bengali (India) voice. With it: `bn-BD` Nabanita (female) / Pradeep (male).

1. Sign in at https://portal.azure.com (a free account works).
2. *Create a resource* → search **Speech** → *Speech service* → *Create*.
   - Region: **Southeast Asia** · Pricing tier: **Free F0** (enough for testing) · *Review + create*.
3. Open the resource → *Keys and Endpoint* → copy **KEY 1** and **Location/Region**.

```
AZURE_SPEECH_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AZURE_SPEECH_REGION=southeastasia
```

## 3. Public address (required for real calls)

When someone answers, Twilio asks *your* API what to play and tells it which key was pressed,
so the API must be reachable from the internet. `cloudflared` is installed for this.

In a terminal in `D:\Data\Data`:

```
npm.cmd run app:tunnel
```

It starts a free Cloudflare tunnel to `http://localhost:8787` and writes its address into `.env` as
`APP_URL=https://….trycloudflare.com`. **Then restart the API.** The address changes every time you start the tunnel, so
run it again (and restart the API) after a reboot. Stop it with `Stop-Process -Name cloudflared`.

Anyone who knows that address can open the app's sign-in page while the tunnel runs. Stop the tunnel when you are not testing calls.

## 4. Start the app

Two terminals in `D:\Data\Data` (PostgreSQL must be running):

```
npm.cmd run app:api
```
```
npm.cmd run app:web
```

Open http://localhost:5173 and sign up / sign in. (Or, after `npm.cmd run app:build`, use only `app:api` and open http://localhost:8787.)

## 5. In the app

1. **Settings → Sending**
   - *Sender name*: spoken at the start of every call ("এটি <name> থেকে একটি স্বয়ংক্রিয় কল"). Bangla is fine.
   - *Calling hours* (Dhaka time, default 9–20): calls only go out inside these hours.
2. **Credits**: each call costs 3 credits; a new workspace has 200. Buy more in *Settings → Billing* (test gateway, no money).
3. **Recipients**: *Lists → Import from Excel* (or *Add contacts*), or add numbers directly in the campaign.
4. **Campaigns → Auto call**
   - Pick the list and/or add numbers by hand.
   - *Computer voice*: write the message in Bangla, press **Listen**.
     *My own voice*: **Record** (allow the microphone) or **Upload audio** (MP3/WAV/M4A, max 75 s).
   - **Call me**: enter your own number for a free test call (works only with Twilio set up and the tunnel running).
   - **Check audience & preview** → **Launch now**.
5. **Results** (campaign page): ringing → answered / not reached; *pressed 1* = interested; *pressed 9* = added to your
   do-not-contact list automatically.

## 6. Quick checklist when a real call does not work

| Symptom | Fix |
|---|---|
| Editor says "Test mode" | `TWILIO_*` empty or API not restarted |
| "Call me" fails: permission / geo | Twilio *Geo permissions* → Bangladesh |
| Trial: "number is unverified" | add the number under *Verified Caller IDs* |
| Phone rings, then silence / hangs up | tunnel not running or `APP_URL` old: `npm.cmd run app:tunnel`, restart API |
| Bangla sounds Indian | add `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION`, restart API |
| Nothing happens after Launch | outside calling hours (Settings → Sending), or campaign scheduled for later |

## Before calling customers

Check Bangladesh rules (BTRC) for automated marketing calls. The app always says who is calling, offers "press 9" to stop,
respects your do-not-contact list and calling hours, but that is not a legal approval.
Also note: `.env` has real SMTP settings, so **email** campaigns send real email.
