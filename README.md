# Test Portal

A QR-first UPES assessment app. The admin creates a test, shares its student QR code, approves or rejects registrations, and presses **Start** when the cohort should begin.

## Run locally

1. Copy `.env.example` to `.env` and set `SESSION_SECRET`.
2. Run `npm install`.
3. Run `npm run dev` and open `http://localhost:3000`.
4. Add the Brevo values below to `.env` (optional locally: without them, sign-up and reset codes are printed in the server console), then create an account with any faculty UPES email.
5. Create a test, approve registrations, and press **Start test** when ready — or give it a start time and it starts by itself. Approved students with the page open begin automatically.

For phones on the same Wi-Fi, set `PUBLIC_BASE_URL` in `.env` to your computer's LAN address, e.g. `http://192.168.1.25:3000`, and allow port 3000 through the firewall. In deployment, set it to the public HTTPS URL instead. A QR containing `localhost` only works on the computer running the server.

## Who can use it

Everyone logs in with **email + password** (the email is the username). Only addresses at `upes.ac.in` or one of its subdomains can have an account.

- **Create an account:** enter your email, type the 6-digit code emailed to you (through Brevo), then your name and a password (at least 8 characters).
- **Forgot password:** enter your email, type the emailed code, and choose a new password. Every other device is signed out.
- Passwords are stored as salted scrypt hashes. Five wrong passwords lock the account for 15 minutes. A login lasts 12 hours.

- `@stu.upes.ac.in` accounts are **students**. They register for tests, and their home page is **My results**: every test they took, the time it took, and their marks once released.
- **Sign in with Microsoft** is an extra option for any UPES account (the `AZURE_*` values in `.env`, redirect URI `<PUBLIC_BASE_URL>/auth/microsoft/callback`). Students' and faculty's Microsoft accounts are in different tenants, so the Azure app must be **multi-tenant** and `AZURE_TENANT_ID=organizations`; `AZURE_ALLOWED_TENANTS` limits it to your directories. The button disappears if the Azure values are missing.
- Every other UPES address (e.g. `@ddn.upes.ac.in`) is **faculty**. Faculty get a private admin portal showing only the tests they created, and they can **also take tests** with no SAP ID. **My results** is in their menu too.

Accounts are kept until an administrator deletes them. Test records and marks are stored on the tests, not the account, so deleting an account never removes marks.

A student enters their **9-digit SAP ID** once. It is saved to their profile and reused for every later test, so one student cannot sit two tests under two different IDs. A registration stays **pending** until the admin approves it individually, approves all pending requests, or rejects it.

Emailed codes are rate-limited to protect Brevo's free allowance of 300 emails a day: one code per address per minute, 8 per address per day, and a server-wide daily cap (`OTP_DAILY_LIMIT`, default 295). A code expires after 10 minutes and allows 5 tries. Logging in with a password sends no email.

### Users page

Faculty listed in `ADMIN_EMAIL` (comma-separated), or every faculty account if it is empty, get a **Users** page:

- **Accounts**: every account, with role, SAP ID, created and last login.
- **Delete**: removes the account and password, signs it out, and clears the saved SAP ID, so a mistyped ID can be entered again. The person can create a new account.
- **Block**: signs the person out and refuses password login, codes and Microsoft sign-in until you unblock them, so they cannot take any test. The account is kept, so unblocking restores it.

### Guests

Each test carries its own **Allow guest registrations** switch, in both the create form and **Edit test setup**. It is off by default, and it is the *only* control — there is no server-wide environment flag that can silently override the admin's choice.

With it on, the test's join page also offers **Continue as guest**: the visitor types a display name and gets a temporary account (`Guest: <name>`, at an internal `@guest.test` address) with student-level access to that test only. Guests still enter a SAP ID, still need the admin's approval, and are flagged **Guest — identity not verified** in the dashboard and in the export.

A guest's SAP ID belongs to that seat only and is never saved to a profile, so a guest can never lock a student out of their own SAP ID. A guest cannot use a SAP ID that a signed-in student has already saved.

**Leaving ends the seat.** When a guest signs out, whatever they answered is submitted, so the admin keeps it with its start and finish times, and the seat is marked **Left**. The SAP ID is then free. If they come back as a guest with the same SAP ID, they start a new, blank paper, and both attempts stay on the record with their own times. A guest who closes the browser without signing out gets the same treatment once their session ends (12 hours): the next registration with that SAP ID submits and releases the abandoned seat. Guests have no results dashboard.

Two things follow from that, and are why the switch is off by default:

- A guest's identity is self-declared. Nothing ties the name they typed to a real person. Leave guests off for anything graded.
- A guest session is issued only for a test that allows guests. Turning the switch off closes the door again for new sessions *and* new registrations; students already registered keep their place.

## How the quiz time works

A test has two independent timing choices, so every combination works. Setting a time makes that moment automatic; leaving it unset leaves it to the admin's buttons.

| Starts | |
|---|---|
| **When I press Start** (default) | Approved students wait on a holding screen until the admin presses **Start test**. |
| **Set a start time** | The test starts by itself at that time. Students see a countdown, and the Begin button appears at zero. **Start early** still works. |

| Ends | |
|---|---|
| **When I press Close** | No clock. The admin's **Close test** submits every open paper. |
| **Set an end time** | A wall-clock deadline for everybody. |
| **After a duration** (default: what the questions are expected to take) | So many minutes after the test *actually* starts, so a late Start costs no one time. The end time is fixed at that moment. |

The date and time pickers have one-tap **Now** and **Today** buttons (Today keeps the chosen time and sets today's date), plus quick picks. A one-line summary under them says exactly what will happen.

The end time is **the deadline for everybody**, so **a student who starts late gets only what is left of it**. Nobody may begin a fresh paper once time is up; **Extend time** lets a latecomer in.

**Before the end time** the paper behaves like paper: any question, in any order, any answer changed as often as the student likes, each change written to the server at once. Students get a warning 5 minutes and 1 minute before the end, and the clock turns red in the last minute.

**When time is up, every paper is submitted automatically.** The student's page locks the paper, sends anything still queued on the device, and submits it; the result page says "Time's up — your answers were submitted automatically". Answers still on their way get a **90-second grace** (`END_GRACE_MS`); after that the server refuses them. A background **scheduler** (`src/services/scheduler.js`, every 5 seconds) is the backstop: once the grace has passed it submits every paper still open — including locked ones and those of students who closed the tab — and closes the test, marked *Ended automatically*. The same scheduler starts scheduled tests; a student's page reaching zero also starts it, so nobody waits for the next tick. Everything it needs is in the database, so a restart picks up where it left off.

Each submitted paper records how it ended (`submittedBy`: `student`, `time` or `admin`), which the student's result page shows.

The admin dashboard shows a banner with a live countdown to whatever happens next by itself — *Starts automatically in 04:59*, *Ends automatically in 12:30* — with **+5 / +10 / +15 min** buttons while it runs. The quiz list shows *Starts 24 Sep, 10:00*, *Live · ends 11:00* or *Ended automatically*.

Tests saved before these choices existed keep working: they start when the admin presses Start, and end at their end time or, if they had none, when the admin closes them.

### Editing a test

**Edit test** on the dashboard opens the whole question paper in the same form used to create it: questions, options, answer keys, per-question times, questions per student, and the settings. It works before, during and after the test (`src/services/paper-service.js`). Questions students already have are marked **On N papers**.

Before anyone has a paper, saving simply saves. Once students have papers, saving asks who the changes should reach:

- **Everyone, including papers already given out** — an edited question changes in place: students writing the test see it on their next refresh, and a changed answer key **re-marks papers already submitted**. A deleted question is taken off every paper and scores are recounted. An answer that no longer fits (fewer options, a switch between choice and written answer) is cleared.
- **Only students who start from now** — papers already given out keep every question exactly as it was, and their marks. The old version stays in the bank marked *retired* for those papers; new papers get the edited one.

Either way, new questions and a different number of questions per student reach only papers started from now. Once the test has started, the start time, the timer on every question, how questions are picked and shuffling stay fixed, and the end time is changed with **Extend time**.

### Restarting a quiz

Once a test has started — running or already finished — **Restart quiz** on the dashboard runs it again from the beginning, in one step: every paper and mark is cleared, approved students keep their place (no re-approval), and the test starts again **now**. A duration counts afresh from the restart; a set end time is kept if it is still ahead, otherwise the dialog asks how long the restarted quiz should run. The dialog offers the current results as Excel first, because the old answers are gone for good. Students with the page open are taken back to **Begin** for a new, blank paper.

Two narrower tools stay in the **More** menu: **Blank papers for all** (while running: fresh papers, the end time unchanged) and **Reset to not started** (clears everything and waits for Start). Both keep registrations and approvals.

### If the server goes down during a test

The server runs on the admin's own machine, so it can stop mid-test. Students' pages keep their answers on the device and say *Can't reach the test server* (not *You are offline* — it is not their connection). The server leaves a heartbeat every few seconds (`src/services/outage.js`). When it starts again — or wakes after the machine slept, which pauses it without a restart — it measures how long it was stopped and, for every test that was running (each outage is handled exactly once):

- moves the **end time** later by the outage, and the open question's clock under strict timing with it — nobody loses time;
- does **not** count the gap as students leaving the test, so nobody is locked for it;
- records the outage, shown on the dashboard: *The server was down for 51 s — that time was added back to the test.*

Outages longer than `OUTAGE_EXTEND_MAX_MINUTES` (default 30) are recorded but not given back automatically; extend the time yourself if students need it.

### Extending the time

**Extend time** on the dashboard moves the end time out by however many minutes you choose, and works before *and* during the test. Every paper reads the end time on each request, so an extension reaches every student at once — even one whose clock had just run out, as long as the test has not closed yet. Extending from an end time that has already passed counts the minutes from now, so "+10" really is ten more minutes. Adding time to a test that had no end time gives it one.

The same control accepts an explicit end time through the API (`POST /api/admin/tests/:code/end-time` with `{ "endsAt": "..." }` or `{ "addMinutes": 10 }`), and it can move the end time earlier as well as later. The window must always be a real one — after the start, and no longer than 30 days.

Restarting a student's attempt gives them a **blank paper**, not extra time: the deadline is the test's, shared by everyone. Reviving a locked attempt likewise clears the integrity counters without changing the end time. Extending the test is what gives time back.

## Question layout

Each test chooses how students see their paper, in **Create a test** and in **Edit test setup**:

- **One question at a time** — a question navigator with Previous and Next.
- **All questions on one page** — every question in one scrolling page, with a single Submit at the end.

Both keep the same behaviour underneath: free movement between questions, answers written to the server as you go, and automatic submission when time is up. Only the presentation differs. The question navigator is shown either way; on a single page it scrolls to the question instead of swapping it.

On an ordinary test, questions carry **no time of their own**: the test's end time is the only deadline, and an attempt finishes when the student submits, time runs out, or the admin closes the test.

### Private (Incognito) window only

With **Private (Incognito) window only** on, the test page first checks the window (`client/src/lib/private-mode.js`). Browsers hide private windows on purpose, so no check can be certain: it uses the [detectincognitojs](https://github.com/Joe12387/detectIncognito) signals — on Chrome, Edge and Samsung Internet, how much slower a write that must reach the disk is than one that need not (a private window keeps everything in memory); on Safari and Firefox, a storage feature private windows refuse. It is built to fail open rather than block honest students:

- **Phone browsers that cannot run extensions are not checked** — Chrome on Android and on iPhone, Samsung Internet, Opera, Brave, Firefox on iPhone. Extensions are what the rule guards against, and on phones the timing signal can guess wrong. Safari on iPhone and Firefox, Edge and Kiwi on Android run extensions, so they are checked.
- A window the check reads as **normal** is asked to open the link in Incognito. If the student is already in Incognito, **Continue in this window** lets them in.
- **Try it on a phone first:** `/?page=window-check` (no sign-in) shows what the check decides in that browser, three times over. Open it in a normal tab and in an Incognito tab: they should say *Normal window* and *Private window*.
- **Extensions are also looked for directly**, in any window (`client/src/lib/extension-watch.js`): an element an extension adds to the paper (a custom element, anything loaded from `chrome-extension://`, something put straight onto the page) or a mark it leaves (Grammarly, LanguageTool, Dark Reader, password managers). The student sees a notice that stays, and the dashboard shows a puzzle-piece sign with what was seen. An extension that only reads the page without changing it cannot be seen.
- What the check saw is saved when the student begins, and the **Responses** tab shows it: *Incognito window ✓*, *Phone browser*, *Window unknown*, or a red **Incognito not verified** when the student continued past the check.

### How each student's questions are picked

When the bank holds more questions of a type than one paper uses, **How questions are picked** decides who gets which:

- **Least overlap** (default for new tests) — the bank is put in one fixed order for the test (shuffled once, if shuffling is on), and each student who *begins* takes the next block of it, per question type, wrapping round at the end. Students who begin one after another — usually the ones sitting side by side — get completely different questions until the bank runs out, and every question is used about equally. The form says what that means for your bank, e.g. "3 students in a row get completely different MCQs". A student keeps their block if they reload or the admin restarts them; **Reset** hands the blocks out from the start again.
- **Fully random** — an independent random pick per student (the only behaviour before this choice existed, and still what older tests use). Two students share about *drawn² ÷ bank* questions of each type on average, and the form shows that number.

The order of questions *within* a paper is shuffled per student either way when **Shuffle question order** is on.

### Strict timing (a timer on every question)

Turn on **Strict timing** when creating a test (or in **Edit test setup** before it starts) to give each question its own time:

- **Time per type** — MCQ, MSQ and short answer each get a default (1 min, 1 min, 2 min to begin with; 0 = no limit).
- **Time per question** — any question can override that in the question editor (*Default*, *No limit*, 15 s … 5 min, or a custom number of seconds). JSON imports can carry `strictTiming`, `typeSeconds` and a question's `timeSeconds`.
- **Submit test** is always on screen, so a student can hand in the paper at any point (confirming first). There is never a Back button.
- **Show a Next button** (on by default) is the admin's choice. Turned off, a timed question stays on screen for its full time and the server refuses any early move; a question with **no** timer still gets Next, so nobody is stuck.
- Confirmations during a test (Submit, Skip) are drawn in the page. The browser's own `confirm()` box would take the page out of fullscreen, and dismissing it with Escape would count as leaving the test.
- The paper shows **one question at a time, forward only**. A timed question counts down (red for the last 10 seconds); at zero the answer as it stands is kept and the next question opens by itself. **Next** moves on early; skipping an unanswered question asks first. A question with no limit waits for Next. There is **no going back**, and Next on the last question submits the paper.
- The clock is the server's (`src/domain/strict-timing.js`). Only the open question is ever sent to the browser, and only it accepts answers — for its time plus a 3-second grace. A question's clock starts when it is first shown, so a dropped connection costs the question that was open, never the ones after it. **It counts only while the student is on the paper:** leaving it (another app or tab, out of fullscreen) or being locked stops the open question's clock, and it carries on from where it stopped once they are back, so its time on screen is time actually spent on it. The test's own end time keeps running, and every exit is still recorded and counted against the limits.
- The test's own start and end still apply on top: when the overall time is up, the paper is submitted as usual. The suggested duration adds up the longest question times a student could draw.
- The panel shows how long a student's paper can take with the chosen timers (the longest questions each student could draw).
- The admin's analysis view, activity log and Excel **Responses** sheet show each question's time allowed, time on screen, and whether it timed out. Strict settings are fixed once the test starts.

## Working through a bad connection

Campus Wi-Fi drops. The student's paper is built so that a short outage costs nothing:

- **An answer appears the moment it is tapped**, is written into this device's storage, and is queued for the server. A queued answer is marked *"Saved on this device, sending…"* and its number in the navigator is outlined, so the student can see what has not landed yet.
- **The queue retries by itself** — when the browser reports the connection is back, and on a slow beat in case it never does (captive portals, flaky mobile data). A banner says how many answers are waiting.
- **Reloading during an outage still opens the test.** A service worker caches the app itself, and the paper plus its queue are read back from this device.
- **Submitting waits for the queue.** If anything is unsent, Submit flushes first and asks the student to stay on the page rather than finishing with answers the server never received.

The server stays the authority throughout. The API is never cached, and anything the server refuses — an answer after time is up, a locked attempt, a closed test — is dropped from the queue and the screen reverts to what the server says. Nothing here can invent an answer the server rejected. The stored copy is cleared on submit, so a shared machine keeps nothing.

`/assets/` is fingerprinted by Vite and served `immutable` for a year; the page, the service worker and every API response are `no-store`, so a deployment is picked up on the next visit.

## Test setup

Once students have begun, **Edit / extend time** still accepts everything that cannot reshape a paper: the title, instructions, end time, fullscreen limits, guest and venue rules, and marks visibility. The question mix, shuffling and start time are fixed at that point — papers are already drawn, and changing them would leave the cohort sitting different tests. Reset the test to change those.

Everything in **Edit test setup** can be changed until the moment the test starts: the start and end times, **Questions per student** — how many MCQ, MSQ and short-answer questions each student is drawn from the bank — and **Allow guest registrations**. The estimate updates live and is computed the same way the server computes it, so what you preview is what gets saved. Once the test has started the setup is frozen, but **Extend time** still works; reset the test if you need to change anything else.

Moving the start time past the current end time, without supplying a new end time, rebuilds the window from the estimate rather than failing.

Choose one mark-release policy: immediately after submission, after the test is closed, or only after the admin presses **Release marks**.

## Fullscreen, attempt recovery, and mark release

For each quiz, the admin sets what leaving the test does, under **When a student leaves the test**: two switches, **Warn** and **Lock**, and three numbers. **Exits allowed** and **Total time away** (all absences added up) are free; 0 turns that limit off. Going past either one is a *violation*, counted once per absence. With **Lock** on, **Warnings before lock** says how many violations only warn ("Warning 1 of 2", "Last warning"); the next one locks the attempt until the admin presses Revive, and 0 locks the first time with no warning. **Warn** alone shows a warning on every exit and never locks; with both switches off every exit is only recorded. Tests from before these settings lock with no warning. It can be changed while the test runs; turning Lock off lifts any lock it already has. Exits are logged per attempt either way. Copying, pasting, screenshots, printing and developer tools are blocked, and the student sees a warning, but they never lock. The dashboard shows the exit timeline, lock reason, and total time outside fullscreen, and can revive a locked attempt or restart any attempt from the beginning.

**Going offline counts as leaving.** The paper checks in with the server every 10–15 seconds. A silence longer than 60 seconds (`OFFLINE_SECONDS`), from Wi-Fi or data off or a sleeping laptop, is recorded as one exit ("Went offline"), with the whole gap as time away, and can lock the attempt like any other exit. It is judged the moment the paper reconnects, before any answer queued offline is accepted. A student already recorded as away is not counted twice.

**Server-wide switches.** Every exit and the time away are always recorded and shown (student result and dashboard, admin dashboard and analysis, both exports), and the paper is hidden while the student is away. Whether a test with **Lock** on actually locks also needs the server's `LOCK_ON_EXIT`, which is on unless `.env` sets `LOCK_ON_EXIT=false`; with it off, no test locks. A lock waits for the admin's Revive, unless `LOCK_WAIT_SECONDS` is set, in which case it lifts itself after that many seconds.

**Screenshots.** A web page cannot stop the operating system taking a screenshot, and phones never tell the page. On computers the paper is hidden the instant the Windows / Cmd key goes down (every screenshot shortcut starts with it) and after Print Screen, the clipboard copy is cleared, printing and text selection are blocked, and each attempt is recorded. Tools that take focus (Snipping Tool, screen sharing) count as leaving.

Leaving the test is watched by more than fullscreen: switching tab or app, locking the screen, the window losing focus (split screen, a floating app, another window; on a phone, anything opened over the test — the notification panel, a chat bubble, a search overlay such as Circle to Search), reloading, or the page being put away all count as leaving, and are logged with the time away. Focus lost for under a second (a keyboard switching, the browser's own fullscreen notice) is not counted.

**The screen stays on** from the waiting room until the paper is handed in, locked or not (`client/src/lib/keep-awake.js`), so a phone or laptop never dims and locks itself mid-question — that would count as leaving. It uses the browser's Screen Wake Lock, which needs the portal on **https** (a plain `http://192.168…` address cannot keep screens on); it is taken again whenever the system drops it. iPhones before iOS 18.4, which ignore the wake lock in Safari, play a tiny silent video instead ([NoSleep.js](https://github.com/richtr/NoSleep.js), MIT). That matters on phones — pressing Home fires no fullscreen event, and **iPhone Safari has no Fullscreen API at all**, so watching fullscreen alone recorded nothing there. A browser without fullscreen says so on the start screen rather than silently skipping it.

**Fullscreen is required wherever the browser has it.** Pressing Home on a phone and coming back silently drops the page out of fullscreen. The student is not counted as back until they are back *in* fullscreen: until then the paper is covered by a **Return to fullscreen** screen, and that time counts as time away. The paper stays loaded underneath, so a half-typed answer survives. If a browser refuses fullscreen (some in-app browsers do), the refusal is logged and the student continues.

**Everything is recorded, whatever the limits allow.** A limit of `0` means "never lock", not "don't watch". Two sets of numbers are kept:

- the **lock counters** (`fullscreenExitCount`, `fullscreenTotalAbsenceMs`) that the limits read; **Revive attempt** clears these so the student can carry on;
- the **lifetime record** (`attempt.integrity`) that the dashboard, the student analysis and the export read: how many times they left and why, total and longest time away, copy/paste attempts and how many times they were locked. Reviving never clears it and restarting carries it over.

A student who leaves and never comes back is locked by the background refresh once the away limit passes, not only when they return. The server also keeps its own clock on each departure, so a tampered page cannot report "away for 0 seconds". Leave and return events are queued on the phone like answers, so turning Wi-Fi off before switching apps still ends up on the record. Copy, cut, paste, dragging text in and the long-press menu are blocked on the paper and logged, but never lock. A phone keyboard's clipboard (the Gboard or Samsung Keyboard chip) inserts text without any paste event, so it cannot be blocked; instead every change to an answer is measured, and 30 or more characters arriving in one go is recorded against that question (*Text appeared all at once: 151 characters*) — on the student card (clipboard sign), beside the answer in the analysis, and in the Excel columns. Voice typing adds whole phrases at once too, so it is recorded for you to judge, not refused.

Where it shows: the dashboard's **Integrity** column (with an *Away now* marker), the **Analysis** view (counts plus a full timeline), and the Excel export (integrity columns on *Results* and a per-event *Integrity log* sheet).

Fullscreen is a browser-level deterrent, not a device lockdown. Students must tap to enter fullscreen because browsers require a user gesture, and a determined student with a second device is outside anything a web page can see.

## Look and feel

The whole app, test pages included, uses one dark theme defined in [`client/src/styles/theme.css`](client/src/styles/theme.css), loaded after every other stylesheet: page `#1E2124`, navigation `#232629`, cards `#2A2D31`, raised `#33373B`, inputs `#3A3E43`, borders `#474C52` (neutral charcoal greys), and primary blue `#1598D1` for actions; green, red and orange are kept for feedback. Text is Manrope, bundled with the app (no external font request). The **QUIZ.** wordmark, the name in browser tabs and the sign-in line are in [`client/src/brand.js`](client/src/brand.js); the browser-tab icon is [`public/favicon.svg`](public/favicon.svg).

**My quizzes** (the admin home) shows totals for quizzes, registrations, average score and attendance (students present per class), then one card per quiz with its registrations, submissions, average score and submission rate. Search by name or code; filter by status and creation date; sort by newest, oldest, title or score. Each card's menu exports, duplicates (a new, unstarted copy with the same questions and settings, and no students), archives (hidden from the list until you pick Status → Archived) or deletes after a confirmation that can download the results first.

On a test's dashboard: <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> switch tabs, <kbd>/</kbd> jumps to search, <kbd>↑</kbd> <kbd>↓</kbd> move between rows, and on a waiting registration <kbd>A</kbd> approves and <kbd>X</kbd> rejects. The row-height button next to the filters makes the tables compact, remembered on that computer.

## Attendance

**Attendance** in the admin header opens class attendance, separate from tests (`src/services/attendance-service.js`, `src/domain/attendance.js`).

- **Start attendance & show QR** opens a session at once. Options: **Allow guests** (name + SAP ID, no UPES account) and **Check distance from the classroom** (the same venue location and radius as a test; a reading clearly outside is refused, a vague GPS reading is accepted and marked *uncertain* for you to judge).
- **The QR changes every 20 seconds.** Scanning a fresh one gives the phone a 15-minute pass to sign in and mark; a photo of the QR sent to someone outside stops working within about a minute, and the code is removed from the address bar once read.
- A student's mark is **Pending**, with the date and time. **Close attendance** turns every pending mark into **Present**, stamped with the closing time. Before closing, **Remove** takes out a wrong mark (and **Restore** puts it back).
- **Take attendance again** opens another round with a new QR for latecomers. Those already present stay present; a mark in a later round is shown as **Late · round N**. Each round's open and close times are kept.
- One account and one SAP ID mark once per session. When **one phone marks for several people**, the list says *Same phone as …* — the usual sign of proxy attendance.
- **Download Excel** gives the list (status, round, late, marked and confirmed times, distance, shared phones) and a sheet of rounds.

`npm run test:attendance` runs the whole flow against the MongoDB in `MONGODB_URI` and cleans up after itself.

## The Excel export

**Download Excel** on the dashboard gives one workbook with six sheets:

- **Overview** — registered, started, submitted, average / median / highest / lowest score, average time taken, how many left the test, how many are locked.
- **Results** — one row per student: marks, percentage, rank, time taken, and every integrity count.
- **Answer grid** — students down, questions across: what each student answered, marked ✓ or ✗ and coloured (green correct, red wrong, yellow awaiting a manual mark, grey blank, white not on that student's paper), with the answer key in the first row.
- **Question analysis** — per question: how many papers it was on, answered, blank, correct, incorrect, % correct, and the most common wrong answer.
- **Responses** — one row per student per question, with when it was answered and how many minutes into the attempt.
- **Integrity log** — every departure, return, copy/paste attempt and lock, in time order.

## Importing a quiz from JSON

In **Create a test**, press **Import JSON** next to the title and choose a `.json` file. The app fills the title, timing, question mix, questions, options and correct answers, then lets the admin review and edit everything before creating the quiz. **Template** downloads [`quiz-template.json`](public/quiz-template.json), a working example. Correct answers can be option indexes (starting at `0`) or the exact option text.

**Formatting a question.** The question box in the editor has buttons for **bold**, bullet points and numbered lists (Ctrl+B for bold; Enter starts a new line, and inside a list the next item), and shows a preview of the student's view. It is written as plain text — `**bold**`, `- ` bullets, `1. ` numbers — so a JSON file can use it too. Students see it formatted; spreadsheets get it as plain text with • bullets.

Every key is optional except `questions`; anything left out keeps the form's default.

| Key | Meaning |
|---|---|
| `title`, `instructions` | Text |
| `startsAt` | Start by itself at this time (ISO, e.g. `2026-09-30T10:00:00+05:30`). Leave out to start with the Start button |
| `endsAt` | Submit every paper automatically at this time |
| `durationMinutes` | Or: run this many minutes from the actual start |
| `untimed: true` | Or: no clock; ends when the admin presses Close |
| `questionMix` | `{ "mcq": 1, "msq": 1, "short": 1 }` — how many of each type each student gets |
| `questionDraw` | `"spread"` (least overlap) or `"random"` |
| `strictNext` | `false` hides Next under strict timing (default `true`) |
| `strictTiming`, `typeSeconds` | A timer on every question, and the default seconds per type (0 = no limit) |
| `questionLayout` | `"one"` (one at a time) or `"all"` (one page); ignored under strict timing |
| `shuffleQuestions`, `allowGuests`, `requirePrivateWindow`, `locationRequired` | `true` / `false` |
| `fullscreenExitLimit`, `fullscreenAbsenceLimitSeconds` | Exits allowed, and seconds away allowed in total (0 = no limit) |
| `warningsBeforeLock` | With `"warn_lock"`: how many times going past a limit only warns before the next time locks (0 = lock at once) |
| `violationAction` | `"lock"` (default: no warnings; past the limit the attempt waits for the admin's Revive), `"record"` (recorded only, no warning or lock), `"warn"` (a warning each time, never locked) or `"warn_lock"` (a numbered warning each time, then the lock after the last one) |
| `resultReleaseMode` | `"instant"`, `"after_quiz"` or `"admin"` |
| `questions[]` | `prompt`, `type` (`mcq` / `msq` / `short`), `options`, `correctOptions`, and optionally `timeSeconds` for strict timing. A `prompt` may be formatted: `**bold**`, a new line as `
`, lines starting `- ` for bullet points and `1. ` for a numbered list (the template shows each) |

## Project layout

```
src/                     Node/Express API
  server.js              app bootstrap: middleware, static files, error handling
  config.js              environment configuration
  routes/api-router.js   every HTTP route, one line each
  auth/                  email + password accounts, faculty Microsoft sign-in, sessions, role guards
  domain/                pure rules, no database
    question-bank.js       question types, pools, per-student selection
    test-builder.js        validates an admin payload, derives the end time
    attempt-rules.js       THE START / END POLICY: start and end modes, the one
                           shared deadline, and the grace before auto-submission
    presenters.js          what each role is allowed to see
  data/test-repository.js  all MongoDB access for tests and registrations
  services/              use cases, one file per actor
    test-service.js        create and edit a test
    registration-service.js  joining a test, guest sessions and exits, SAP ID profiles, my results
    user-service.js        the Users page: list, delete, block
    attempt-service.js     starting, answering, submitting a paper
    admin-service.js       dashboard, marking, lifecycle, exports
  export/spreadsheet.js  the Excel workbook
  lib/                   errors, crypto, time helpers

client/                  React single-page app, built by Vite into client/dist
  src/lib/               api client, formatting, geolocation, quiz maths
  src/components/        pieces shared across screens
  src/screens/
    HomeScreen.jsx
    admin/               quiz list, dashboard, and its modals
    creator/             the create-a-test form and JSON import
    student/             register, wait, sit the paper, see the result
  src/styles/            base.css (portal skin) + app.css (screen layout)

tests/                   node --test unit tests, no database needed
scripts/regression-check.js  end-to-end run against a real MongoDB
public/                  only files served as-is (the quiz JSON template)
```

## React + Node architecture

The browser UI is a React application in [`client/src`](client/src), built by Vite into `client/dist`. Express serves that production React build and the Node/Express API, while MongoDB stores tests, registrations, attempts, and saved SAP ID profiles.

- `npm run build:client` builds the React client.
- `npm run start` builds and serves the full app on port 3000.
- During React UI work, run `npm run dev` in one terminal and `npm run dev:client` in another; the Vite server at `http://localhost:5173` proxies the API and authentication routes to Express on port 3000.

## Tests

- `npm test` runs the unit tests in [`tests/`](tests). They cover the start / end policy (every start and end combination, the grace, that an extension reopens the paper, and that a late starter shares the same deadline), the question-pool draw, the window and estimate calculation, SAP ID validation, and the Excel export. No database required.
- `npm run audit` runs [`scripts/audit.js`](scripts/audit.js): 100+ checks driving edge cases on purpose — expired windows, extensions, wrong students, wrong admins, locked and submitted attempts, malformed answers, shuffled scoring — reporting every failure rather than stopping at the first.
- `npm run check:http` runs [`scripts/http-check.js`](scripts/http-check.js), which boots the server and walks a student through over real HTTP: cookies, role guards, routing and the error handler, none of which the service-level checks touch.
- `npm run check:load` runs [`scripts/load-check.js`](scripts/load-check.js): a whole class at once over real HTTP — 200 students by default (`STUDENTS=100 npm run check:load`) register, wait, start together, answer, leave and return, and all press Submit in the same instant. Retryable connection/overload failures are retried like the browser and reported separately. It then verifies every stored answer, mark and departure in the database and prints both request and eventual response times per phase.
- `npm run test:regression` runs [`scripts/regression-check.js`](scripts/regression-check.js) against the MongoDB in `MONGODB_URI`: a full run through registration, approval, sitting a paper, time running out and the scheduler's automatic submission, scheduled starts and durations, marking, exporting, and every reset path. It cleans up the documents it creates.
- `npm run check:concurrency` runs [`scripts/concurrency-check.js`](scripts/concurrency-check.js): the moments when many writes land together — 30 guests racing for one SAP ID (one seat), one student registering from 20 devices (one registration), 20 simultaneous Begins (one paper), the admin editing a question for everyone while students answer (no answer lost), and 150 students submitting while the admin closes the test (every paper submitted once, exact and marked right).
- `npm run check:migration` runs [`scripts/migration-check.js`](scripts/migration-check.js) on a copy of a backup (never the real database): it performs the move to per-student documents and compares everything the app loads with the backup, field by field — a clean move, a second start, and a move interrupted half-way.

Run the database checks against a scratch database, e.g. `MONGODB_URI=mongodb://127.0.0.1:27017/campus_quiz_verify npm run test:regression`, so a live database is never touched.

## Email sign-in (Brevo) configuration

1. Create a free account at [brevo.com](https://www.brevo.com) (300 emails a day, no card needed).
2. Under **Senders, Domains & Dedicated IPs → Senders**, add and verify the address the codes will come from.
3. Under **SMTP & API → API Keys**, create an API key.
4. Set these in `.env` and restart the app:

```env
PUBLIC_BASE_URL=https://yogeshrathia.com
BREVO_API_KEY=your-brevo-api-key
MAIL_FROM_EMAIL=the-verified-sender@example.com
MAIL_FROM_NAME=Quiz Portal
ALLOWED_EMAIL_DOMAIN=upes.ac.in
STUDENT_DOMAIN=stu.upes.ac.in
# Optional: only these faculty may open the Users page. Empty = all faculty.
ADMIN_EMAIL=you@ddn.upes.ac.in
```

Without `BREVO_API_KEY`, a development server prints each sign-up or reset code to its console instead of emailing it; a production server (`NODE_ENV=production`) refuses to send.

## Database

Data is stored in MongoDB. Set `MONGODB_URI` in `.env` to a local `mongod` (e.g. `mongodb://127.0.0.1:27017/campus_quiz`) or a MongoDB Atlas connection string; the database is created automatically on first use.

Redis is optional for one local Node process and required for a cluster. It stores only short-lived coordination locks and cached copies of shared test settings; students, tests, answers, results and sessions remain in MongoDB and remain visible in Atlas. Test-setting writes publish an invalidation to every worker, and a short TTL is the fallback if that message cannot be delivered.

- **`tests`** — one document per quiz: its settings and question bank.
- **`registrations`** — one document per student per quiz: the registration, the paper (assigned questions, answers, integrity events) and its activity log, keyed by `{ testCode, id }`. The database itself guarantees one registration per email per quiz.

Every write is a single atomic update of one document, with no need for multi-document transactions, so a standalone `mongod` works (no replica set).

### A whole class at once

Each student writes only their own small document (a few KB, the same at 50 students or 1,000), so a whole class saving and submitting together does not queue behind itself:

- **Student requests read only their own registration** and a cached copy of the quiz settings. A same-worker burst is collapsed to one load; with Redis, every worker shares the result. MongoDB remains authoritative.
- **Every write is conditional on what it read.** A submit grades and closes the paper in one write that only lands if the answers are unchanged, so an answer racing a submit is either scored or refused, never saved unscored; two taps on Submit finalise once; two simultaneous Begins create one paper. Editing a question for everyone rewrites each paper only over the version it read, re-reading it when a student saved in the same moment, so no answer is lost.
- **The few checks across students** — is this SAP ID free before a seat is taken, or changed — run one at a time per quiz. A single process uses its local queue; multiple processes use the same Redis lock, so they cannot interleave those checks.
- **Browser traffic is adaptive and jittered.** A normal paper checks in every 18–25 seconds instead of 10–15; hidden pages back off to 28–36 seconds, while locked/paused papers check faster so Revive still feels immediate. Waiting rooms, attendance and dashboards also avoid fixed-second request waves. Rapid changes to one answer are coalesced before being sent.
- **Admin tables are server-paged** to at most 100 rows, with server-side search/filter counts. Their MongoDB query projects only summary fields; a complete paper is loaded only when its analysis is opened.
- **Excel work runs in bounded worker threads**, so a large report cannot freeze answers or submissions. Repeatable polls are shed before writes during an exceptional burst, and `/api/admin/performance` exposes per-worker request, event-loop, memory, cache and export-queue measurements.

### Slow and interrupted networks

- The current paper and unsent answers are mirrored to both local storage and IndexedDB. A reload without a connection can recover the paper by test code; reconnecting sends only the newest value for each question.
- Answer writes request a compact acknowledgement containing the saved answer and state counters, never the prompts, choices or whole paper. Polls carry the last paper revision and receive an empty `204` when nothing changed.
- Failed answer and submission writes retry with capped exponential jitter. Exit, return and integrity reports use a short batch (exits still leave immediately so a hidden phone cannot suspend them). GPS checks remain immediate by design: replaying an old location later would give a misleading venue decision.
- The paper always shows **Synced**, **Saved on this device**, or **Offline / server unreachable**, so a student knows where an answer currently exists. JSON, HTML, CSS and SVG responses are compressed when large enough to benefit.
- At the shared deadline the page still locks immediately, but the server now allows 90 seconds for already queued answers to arrive before automatic finalisation. Client timestamps are never trusted to extend the deadline.

Measured with `npm run check:load` on one laptop (i5-1335U) against a local MongoDB, every student answering 20 questions back-to-back — far harsher than a real exam — and then everyone saving and pressing Submit in the same instant:

| Students | Last Submit confirmed | Whole run | Failed requests |
|---|---|---|---|
| 100 | 0.09 s | 4 s | 0 |
| 300 | 0.23 s | 11 s | 0 |
| 500 | 0.42 s | 18 s | 0 |
| 750 | 0.70 s | 29 s | 0 |
| 1000 | 0.74 s | 38 s | 0 |

(With every student inside one quiz document, as before, 750 students took 41 s to confirm and the 1,000 run could not finish in 25 minutes.) Each attempt's event log is capped at 200 entries, so no student's document comes near MongoDB's 16 MB limit.

A focused post-optimization capacity run on the same development machine used one question per student, one simultaneous final-answer burst and one simultaneous Submit burst. This isolates the connection/write spike rather than question-rendering time:

| Students | Last Submit confirmed | Final failures | Transient retries recovered |
|---|---:|---:|---:|
| 2,500 | 2.99 s | 0 | 287 answer retries |
| 5,000 | 4.20 s | 0 | 593 answer retries |
| 7,500 | 9.31 s | 0 | 318 answer retries |

For 5,000 students, the final-answer request had an eventual p95 of 8.60 s and Submit p95 of 3.57 s; all 5,000 MongoDB papers and marks were then checked. The 7,500 safety-headroom run also had no final failure (answer p95 11.27 s, Submit p95 8.34 s). These synthetic results demonstrate recovery and local capacity, not an Internet/Atlas production guarantee. Production still needs multiple Node workers, managed Redis, a suitably sized Atlas deployment and a load test from outside the hosting machine.

### Multiple Node processes

Set `REDIS_URL` before starting more than one Node process. The server refuses to start in PM2 cluster mode without Redis rather than silently running with unsafe process-local locks. A managed TLS Redis service normally supplies a `rediss://...` URL.

```env
MONGODB_URI=mongodb+srv://...
REDIS_URL=rediss://...
SESSION_SECRET=the-same-long-secret-on-every-worker
WEB_CONCURRENCY=6
```

Build once, install PM2 on the server, then use the included [`ecosystem.config.cjs`](ecosystem.config.cjs):

```sh
npm run build:client
npm install --global pm2
pm2 start ecosystem.config.cjs --env production
pm2 save
```

PM2 starts `WEB_CONCURRENCY` workers (or one per CPU core when it is omitted) on the same port. Login sessions already live in MongoDB. Redis coordinates per-test writes, per-paper writes, scheduler leadership, shared test caching and cache invalidation; if Redis is unavailable, affected writes return a retryable `503` instead of falling back to unsafe local locking. The browser retains and retries unsent answers and retries idempotent submissions.

Run `npm run check:redis` with `REDIS_URL` pointed at a disposable Redis database to start two real Node processes and verify that one shared write never overlaps and only one scheduler leader runs. Keep `npm run check:concurrency` and `npm run check:load` in the deployment verification too.

### Backups and the move to per-student documents

- `npm run db:backup` writes the whole database to `backups/<database>-manual-<time>/` (every collection with exact types and its indexes; each file is read back and compared). `npm run db:restore -- backups/<folder>` puts one back — stop the server first. **Backups hold account data: keep the folder private** (it is git-ignored).
- Quizzes saved before per-student documents are moved automatically the first time the new server starts, before it serves anything: the whole database is backed up to `backups/<database>-before-student-documents-<time>/`, each quiz's original list is also kept in `registrationsMigrationBackup`, every copied student is compared field by field with the original, and the list leaves the quiz document only if all of them match. If anything does not match, the server does not start and nothing is removed. To go back to a version from before the move, restore that backup.

## Production notes

- Use HTTPS, a managed MongoDB deployment (e.g. Atlas), a managed Redis service for multiple workers, a durable shared session secret, and a process manager in production.
- The QR code is deliberately public. Every faculty UPES account gets a private admin portal: it can view, approve, export, or start only the quizzes it created. `@stu.upes.ac.in` accounts are admitted as students, faculty may sit tests too, plus guests on the tests whose admin allowed them.
- Guest registrations carry no verified identity. Keep them off for graded assessments.
