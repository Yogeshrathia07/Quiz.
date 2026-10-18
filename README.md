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
- Every other UPES address (e.g. `@ddn.upes.ac.in`) is **faculty**. Faculty get a private admin portal showing only their quizzes: **Home · Quizzes · Results · Attendance** (and **Users** for those allowed). **Quizzes** handles creation, setup and students; **Results** handles submitted papers, marking and analysis, with a switch for **My attempts**. A quiz can link directly between its management and results workspaces. Old Tests links still work. Faculty can also take quizzes without a SAP ID.
- In a results list, a test that ended without the person beginning a paper reads **Missed** (grey), not "Not started".

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
| **After a duration** (default: what the questions are expected to take) | So many minutes, **counted from** one of: |
| &nbsp;&nbsp;→ **The test's start** (default) | After the test *actually* starts, so a late Start costs no one time. The end time is fixed at that moment, the same for everyone. |
| &nbsp;&nbsp;→ **Each student's start** | From each student's own **Begin**: everyone gets the whole duration, however late they begin. The test itself has no end and stays open until you press **Close**. |

The date and time pickers have one-tap **Now** and **Today** buttons (Today keeps the chosen time and sets today's date), plus quick picks. A one-line summary under them says exactly what will happen.

### Each student's own time

With **After a duration → Counted from: Each student's start** (`endMode: "each"` in [`attempt-rules.js`](src/domain/attempt-rules.js)) every paper has its own end: the student's Begin plus the duration, plus any time given back. Approved students can begin at any time until you press **Close**.

- **Students** are told "You get 30 min from when you press Begin". While writing, the timer counts down *their* time remaining ("Your time left 12:04", seconds included), with the usual 5- and 1-minute warnings. When it runs out, their paper is submitted automatically - by their page, or by the scheduler within seconds if the tab was closed - and the result page says "Your time was up at 10:42". Others carry on.
- **The dashboard** shows *Live · 30 min each, from their own Begin*, how many are writing and when the last of them runs out; each student's row shows *ends 10:42*. **+5 / +10 / +15 min** (or **More → Give more time**) gives the minutes to everyone still writing, from their own end - or from now if theirs has already passed. One student alone: pause or reopen their paper.
- **Close test** first says how many are still writing and until when, then hands every open paper in. **Resume test** gives each reopened paper back the time the test was closed; an outage is given back paper by paper the same way.
- Once the test has started, it cannot switch between each student's own time and a shared end (or change the duration); Reset it to.

Otherwise, the end time is **the deadline for everybody**, so **a student who starts late gets only what is left of it**. Nobody may begin a fresh paper once time is up; **Extend time** lets a latecomer in.

**Before the end time** the paper behaves like paper: any question, in any order, any answer changed as often as the student likes, each change written to the server at once. Students get a warning 5 minutes and 1 minute before the end, and the clock turns red in the last minute.

**When time is up, every paper is submitted automatically.** The student's page locks the paper, sends anything still queued on the device, and submits it; the result page says "Time's up — your answers were submitted automatically". Answers still on their way get a **90-second grace** (`END_GRACE_MS`); after that the server refuses them. A background **scheduler** (`src/services/scheduler.js`, every 5 seconds) is the backstop: once the grace has passed it submits every paper still open — including locked ones and those of students who closed the tab — and closes the test, marked *Ended automatically*. The same scheduler starts scheduled tests; a student's page reaching zero also starts it, so nobody waits for the next tick. Everything it needs is in the database, so a restart picks up where it left off.

Each submitted paper records how it ended (`submittedBy`: `student`, `time` or `admin`), which the student's result page shows.

The admin dashboard shows a banner with a live countdown to whatever happens next by itself — *Starts automatically in 04:59*, *Ends automatically in 12:30* — with **+5 / +10 / +15 min** buttons while it runs. The quiz list shows *Starts 24 Sep, 10:00*, *Live · ends 11:00* or *Ended automatically*.

Tests saved before these choices existed keep working: they start when the admin presses Start, and end at their end time or, if they had none, when the admin closes them.

### Editing a test

**Edit test** on the dashboard opens the whole question paper in the same form used to create it: questions, options, answer keys, marks, questions per student, and the settings. It works before, during and after the test (`src/services/paper-service.js`). Questions students already have are marked **On N papers**.

Before anyone has a paper, saving simply saves. Once students have papers, saving asks who the changes should reach:

- **Everyone, including papers already given out** — an edited question changes in place: students writing the test see it on their next refresh, and a changed answer key **re-marks papers already submitted**. A deleted question is taken off every paper and scores are recounted. An answer that no longer fits (fewer options, a switch between choice and written answer) is cleared.
- **Only students who start from now** — papers already given out keep every question exactly as it was, and their marks. The old version stays in the bank marked *retired* for those papers; new papers get the edited one.

Either way, new questions and a different number of questions per student reach only papers started from now. Once the test has started, the start time, whether the paper is held one question at a time with a timer on each, the question times, how questions are picked and shuffling stay fixed, and the end time is changed with **Extend time**. What can still change while it runs: **Next** (on or off), **Previous** on a paper with no timer (turned on — never off again, see *Strict timing*), and on a free paper **All on one page ↔ One at a time**. Students' open papers follow such a change at once.

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

## The Create page

**Create a test** is laid out for someone using it the first time (`client/src/screens/creator/CreatorScreen.jsx`). Along the top, always in view however far down the page you are, a bar holds the four parts as one row of pill tabs - **Questions**, **Schedule**, **Question settings**, **Rules**, the open one filled blue - and on the right **Import questions** (from a file, pasted JSON, or the template) and **Create quiz** (**Save changes** when editing). A tap on a part opens it under the **Title** and **Description**; a second tap closes it. While no part is open, **Your test so far** says in one line what each part holds, and a tap on a line opens that part:

1. **Questions** — the bank as a list, one row a question (its words, type, number of options and marks); a row opens its editor underneath. **Add question** is under the list. A choice question has **2 to 10 options**: **Add option** adds one (up to 10) and ✕ removes one (never below 2), and the tick beside an option marks it right.
2. **Schedule** — when the test starts (when you press Start, or by itself at a set time) and when it ends (when you press Close, at a set time, or after a duration from the test's start or each student's own Begin), summed up in one line. On a test that has started it shows what is running; the end time then changes with **Extend time**.
3. **Question settings** — questions each student gets (how many of each type, shuffling, and how questions are picked when the bank is bigger than one paper), marks for each type and when students see them, and moving through the paper (one page or one at a time; Previous, Next and a timer on each question).
4. **Rules** — who can take it (devices, private (Incognito) window only, guests, the venue) and **Leaving the test**: what happens when a student switches away or leaves fullscreen, always shown.

Each group inside a part has a heading and one line on what it is for, and every choice says in a line what the option picked does, so the defaults can be left alone and only what matters changed. Anything not finished when you press **Create quiz** opens its part (and question) for you.

**On every screen.** The bar is laid out for each size: from a laptop up (1000 px) the parts and the buttons share one row; narrower, the buttons come first and the parts take the whole width under them, with short names (Questions, Schedule, Settings, Rules) below 900 px; on a phone Import shows as its icon; on a phone turned sideways everything is one row, to save height. Nothing scrolls sideways, and a field the browser points at is never hidden under the bar.

**Drafts.** A test being written is kept as a draft on the server for its teacher (`src/services/draft-service.js`, the `creatorDrafts` collection): saved a moment after each change and as the page is left, so leaving the page, closing the tab or signing in on another computer loses nothing. It saves quietly: the bar says nothing while all is well, and shows a red note only when a save fails (no connection, or the draft is too big). Opening **Create a test** again brings it back as it was, with **Clear** to throw it away; creating the test throws it away too. It is never stored on the device, because it holds the answer keys. One draft per teacher, up to 240 KB (pictures are uploaded separately).

## Question layout

Each test chooses how students see their paper, under **Question settings → How questions are shown**:

- **One question at a time** — one question on screen, with three switches under it: **Previous**, **Next** and **Timer on each question** (see *Strict timing* below). With Previous on and no timer, students move freely.
- **All questions on one page** — every question in one scrolling page, with a single Submit at the end.

A test whose students move freely can swap between the two at any time, even while it runs.

With Previous on, both keep the same behaviour underneath: free movement between questions, answers written to the server as you go, and automatic submission when time is up. Only the presentation differs. The question navigator is shown either way; on a single page it scrolls to the question instead of swapping it.

On an ordinary test, questions carry **no time of their own**: the test's end time is the only deadline, and an attempt finishes when the student submits, time runs out, or the admin closes the test.

### Private (Incognito) window only

With **Private (Incognito) window only** on, the test page first checks the window (`client/src/lib/private-mode.js`). Browsers hide private windows on purpose, so no check can be certain: it uses the [detectincognitojs](https://github.com/Joe12387/detectIncognito) signals — on Chrome, Edge and Samsung Internet, how much slower a write that must reach the disk is than one that need not (a private window keeps everything in memory); on Safari and Firefox, a storage feature private windows refuse. It is built to fail open rather than block honest students:

- **Phone browsers that cannot run extensions are not checked** — Chrome on Android and on iPhone, Samsung Internet, Opera, Brave, Firefox on iPhone. Extensions are what the rule guards against, and on phones the timing signal can guess wrong. Safari on iPhone and Firefox, Edge and Kiwi on Android run extensions, so they are checked.
- A window the check reads as **normal** is asked to open the link in Incognito. If the student is already in Incognito, **Continue in this window** lets them in.
- **Try it on a phone first:** `/?page=window-check` (no sign-in) shows what the check decides in that browser, three times over. Open it in a normal tab and in an Incognito tab: they should say *Normal window* and *Private window*.
- **Extensions are not looked for on the page itself.** Guessing from what appears on the page misfired - a translator, a password manager or the phone browser's own additions passed for an extension - and so did guessing at pasted text from how much arrived at once (voice typing and keyboard suggestions do that too). Both checks were taken out; papers recorded before still keep them in the database, but they are left out of every count, log and report (`RETIRED_FLAGS` in `src/domain/integrity.js`). Pasting and dropping into an answer are still refused and recorded.
- What the check saw is saved when the student begins, and the **Responses** tab shows it: *Incognito window ✓*, *Phone browser*, *Window unknown*, or a red **Incognito not verified** when the student continued past the check.

### How each student's questions are picked

When the bank holds more questions of a type than one paper uses, **How questions are picked** decides who gets which:

- **Least overlap** (default for new tests) — the bank is put in one fixed order for the test (shuffled once, if shuffling is on), and each student who *begins* takes the next block of it, per question type, wrapping round at the end. Students who begin one after another — usually the ones sitting side by side — get completely different questions until the bank runs out, and every question is used about equally. The form says what that means for your bank, e.g. "3 students in a row get completely different MCQs". A student keeps their block if they reload or the admin restarts them; **Reset** hands the blocks out from the start again.
- **Fully random** — an independent random pick per student (the only behaviour before this choice existed, and still what older tests use). Two students share about *drawn² ÷ bank* questions of each type on average, and the form shows that number.

The order of questions *within* a paper is shuffled per student either way when **Shuffle question order** is on.

### Strict timing (one at a time, held by the server)

Under **How questions are shown → One at a time**, two switches put the paper in the server's hands, one question at a time: **Previous** off (one way only), or **Timer on each question** on. **A timer on each question means no going back:** a timed question closes once it is left, so the paper goes forward only, and **Next** is the only choice left (Previous is shown off and locked, with the reason). Without a timer, students move on with Next whenever they are ready and the test's own end time is the only limit, and Previous may be on or off. With a timer:

- **Time for each question** — **Same for every question** (one time) or **By question type** (MCQ, MSQ and short answer; 1 min, 1 min, 2 min to begin with). 0 = no limit. The time is the test's, never a single question's: the question editor no longer has a time of its own (a time from an older test or a JSON import is kept on a test that has started, and dropped otherwise).
- **Next** (on by default) lets students leave a question before its time is up. Off, the newest question stays on screen for its full time and the server refuses any early move; a question with **no** timer still gets Next, so nobody is stuck.
- **Previous** is not offered with a timer (above), on a new test, through Edit test, or from the dashboard. A test saved with a timer and going back before this rule keeps both, and works as it did: each question keeps the time it did not use, a question whose time ran out is closed for good, and questions not reached yet still open only one at a time.
- **While the test runs**, the dashboard's **More** menu has **Allow Next** / **Turn off Next** (Edit test does the same). On a one-way paper with no timer it also has **Allow going back**, which can be turned on, never off: questions students have gone back to and read cannot be taken away fairly. Open papers follow at once.
- **Submit test** is always on screen, so a student can hand in the paper at any point (confirming first).
- Confirmations during a test (Submit, Skip) are drawn in the page. The browser's own `confirm()` box would take the page out of fullscreen, and dismissing it with Escape would count as leaving the test. Without Previous, skipping an unanswered question asks first; with it, the question is still there while it has time.
- **The numbers along the top** show each question opened so far as **answered (blue)** or **not answered (grey)**, however it closed — by Next or by its clock; the open one is solid blue. With Previous, a question that can still be opened is a button with a thin blue ring.
- A timed question counts down (red for the last 10 seconds); at zero the answer as it stands is kept and the next question opens by itself.
- The clock is the server's (`src/domain/strict-timing.js`). Only the open question is ever sent to the browser, and only it accepts answers — for what it has left plus a 3-second grace. A question's clock starts when it is shown, so a dropped connection costs the question that was open, never the ones after it. **It counts only while the student is on the paper:** leaving it (another app or tab, out of fullscreen) or being locked stops the open question's clock, and it carries on from where it stopped once they are back, so its time on screen is time actually spent on it. The test's own end time keeps running, and every exit is still recorded and counted against the limits.
- The test's own start and end still apply on top: when the overall time is up, the paper is submitted as usual. The suggested duration adds up the longest question times a student could draw.
- The admin's analysis view, activity log and Excel **Responses** sheet show each question's time allowed, time on screen (all its visits added up), and whether it timed out. The timer and its times are fixed once the test starts.

## Working through a bad connection

Campus Wi-Fi drops. The student's paper is built so that a short outage costs nothing:

- **An answer appears the moment it is tapped**, is written into this device's storage, and is queued for the server. A queued answer is marked *"Saved on this device, sending…"* and its number in the navigator is outlined, so the student can see what has not landed yet.
- **The queue retries by itself** — when the browser reports the connection is back, and on a slow beat in case it never does (captive portals, flaky mobile data). A banner says how many answers are waiting.
- **Reloading during an outage still opens the test.** A service worker caches the app itself, and the paper plus its queue are read back from this device.
- **A Server offline page instead of the tunnel's error page.** With the server off, Cloudflare answers for it with its own error page (502, or 530 / Error 1033 with the tunnel down too). The service worker serves the saved app in its place, and any page but a test link opens on **Server offline** - a sleeping student (`client/public/server-offline.webp`, kept by the worker when it installs), "Studied too hard. Taking a quick nap." - which asks again every few seconds and opens the page the moment the server answers. With no connection on the device itself it says **No connection** instead. Under it, a hand-drawn tic-tac-toe (`components/TicTacToe.jsx`, drawn in code - nothing to fetch): 1 player against the computer (which starts, as X, unless you choose to; it never loses, wins as soon as it can and picks the moves that leave the most ways to go wrong) or 2 taking turns on the device, who starts, New game and the score; while a game is under way the page does not jump away when the server answers - it says **The server is back** with **Open the page**. A device that has never opened the site (or a private window, or a hard refresh) still gets Cloudflare's page.
- **Submitting waits for the queue.** If anything is unsent, Submit flushes first and asks the student to stay on the page rather than finishing with answers the server never received.

The server stays the authority throughout. The API is never cached, and anything the server refuses — an answer after time is up, a locked attempt, a closed test — is dropped from the queue and the screen reverts to what the server says. Nothing here can invent an answer the server rejected. The stored copy is cleared on submit, so a shared machine keeps nothing.

`/assets/` is fingerprinted by Vite and served `immutable` for a year; the page, the service worker and every API response are `no-store`, so a deployment is picked up on the next visit.

## Test setup

Once students have begun, **Edit / extend time** still accepts everything that cannot reshape a paper: the title, instructions, end time, fullscreen limits, guest and venue rules, and marks visibility. The question mix, shuffling and start time are fixed at that point — papers are already drawn, and changing them would leave the cohort sitting different tests. Reset the test to change those.

Everything in **Edit test setup** can be changed until the moment the test starts: the start and end times, **Questions per student** — how many MCQ, MSQ and short-answer questions each student is drawn from the bank — and **Allow guest registrations**. The estimate updates live and is computed the same way the server computes it, so what you preview is what gets saved. Once the test has started the setup is frozen, but **Extend time** still works; reset the test if you need to change anything else.

Moving the start time past the current end time, without supplying a new end time, rebuilds the window from the estimate rather than failing.

**Marks.** Under **Marks for each question** the test sets what each type is worth (1 each unless changed); any question can be worth something else, set in its editor, and then shows a small ☆ sign with its marks in its heading (a question with its own time under strict timing shows a ⏱ sign the same way). Changing a type's marks or time moves every question of that type that still had the old value, so the defaults and the questions never disagree. A choice question is marked automatically - all its marks or none; a short answer can be given any mark from 0 to its marks. Any mark can be changed, a choice question's too (part marks for a nearly-right answer, or none for a right one): **Review** on the Results tab, or the Excel Marks sheet. A changed choice mark is the teacher's own - it shows *Changed by you*, survives re-marking, and **Use automatic** puts it back. Students see what each question is worth on the paper, and every score is out of the paper's full marks. Changing what a question is worth after papers are in re-marks them: choice questions again, and a hand-given mark keeps its share (3.5 of 4 becomes 7 of 8) ([`marks.js`](src/domain/marks.js)).

**Reviewing results.** The Results tab lists every handed-in paper - marks, short answers still to mark, when it was handed in - as a table on a laptop and a card per paper on a phone. A row (or **Review**) opens the review pop-up ([`ResultReviewModal.jsx`](client/src/screens/admin/modals/ResultReviewModal.jsx)), which goes through the papers one answer at a time:

- **By student** - one paper, question by question; **By question** - one question, student by student, optionally only the papers still to mark (the test page's **Mark** button opens it this way).
- Each answer shows the question, the options with the student's choice and the right answer marked (or the written answer), and its mark: type any mark from 0 to what it is worth, or tap 0 or Full. Enter saves and moves on; ← and → move too.
- A row of coloured squares shows where every answer stands - full, part, none, to mark, blank - and jumps to any of them; a blue underline marks a mark you changed.
- Each mark saves at once and reaches the student's result page straight away if their marks are released.

**Answer analysis.** A test's Results area opens on **Analysis** (left of **Results**); beside the test code in the header an (i) shows, on a click, when it was held, how long, marks, questions, papers, how many are shown and how far marking has got, with just the date beside it. Beside **Questions**, **Answer analysis** fits the window. On the left, the question: its header (arrows either side of **Question N** with its type - MCQ, MSQ or Short - which opens the list of questions, each with its type too) stays fixed with the question text - folded to three lines when long, **More** to read it all and see its picture full size - while its options scroll below, each with how many picked it (a correct option has a green letter); on the right (the two halves equal) the students who picked what is chosen, each with their outcome. A small **Score** switch (on at first; turning it off is remembered in this browser) shows each student's marks for the whole test, as the rank list counts them - with **+ up to N to mark** while answers wait for marking. Beside it **Sort & filter** (the rank list's menu) orders the students by marks (highest first at the start), name, SAP ID or time taken, and filters them by the class average, by marking (fully marked or still to mark, while any paper waits) and by what was recorded while they wrote; the line above the list just counts them. Clicking options (a chosen one turns blue) chooses them. Beside the "Question N" heading one joined switch, **Correct | Incorrect | All**, chooses every correct option at once (exactly), answers recorded as incorrect, or everyone; once options are chosen a second, **Picked Exactly | All of | Any of** (**Only | At least** for one option), says how a paper must match: those and nothing else, those and maybe more, or any of them. Grey at rest, blue the one in use. Every click updates the list at once. It opens with the correct options chosen, exactly - the students who got it right; that opening view filters nothing else, so the charts and the Results tab stay whole until a choice is made. Chosen options belong to their own question: the next question opens on its correct answer. **Open in Results** carries the answer choices and search to the Results tab; list-only filters stay in Answer analysis. A name opens that student's selected answer. Answer analysis looks at one question at a time (a choice from a question's statistics replaces any earlier one); an older link with choices on other questions lists them as **Also Q…** chips to remove. On a phone the question comes first, then the students. The question's whole-class counts and option percentages stay visible for comparison; saved answers and marks never change. Charts, question statistics, ranking and CSV export can use the same matching cohort; class ranks and the comparison baseline stay unchanged. A question the student never received is not an unselected option. **Matching results** and **Matching students** preserve the choices in the address and narrow the whole class before pagination. Individual papers remain accessible; clear the analysis choices to restore class-wide export, email and bulk actions. Invalid or unavailable data shows an explicit error rather than silently widening the list.

**Submission progress.** Students see confirmation immediately, then a compact progress window while queued answers save and the final submission is sent. Temporary failures show a waiting/retrying state; permanent refusals and unconfirmed submissions remain explicit. The page shows success only after the server confirms submission. The progress window also covers automatic time-up and the final strict-timing question, with duplicate final requests shared.

**Freezing results.** Once a test is closed, **Freeze** on the Results tab (or **More → Freeze results**) makes its marks final: no marking (by hand or from Excel), no editing the questions or what they are worth, no restart, reset, resume or reopening a paper, and the test cannot be deleted - each is refused with a message saying so, and the test's page shows *Results frozen*. Releasing or holding the marks, viewing and exporting still work, and unmarked papers on a frozen test no longer count as *to mark*. **Unfreeze** (on the Results tab or in More) undoes it, so marks can be changed again; a copy made with Duplicate starts unfrozen ([`freeze.js`](src/domain/freeze.js)).

Choose one mark-release policy: immediately after submission, after the test is closed, or only after the admin presses **Release marks**.

A paper with a short answer still unmarked normally shows *Being marked* until every one is marked. Once the test is closed, **Release marks** on the test's page handles both: with nothing left to mark it releases at once; with papers still waiting it first lists them - each student and how many answers they have to mark - and offers **Mark them first** (the Results tab, on those papers) or **Release anyway**. Released anyway, each student sees the score of what is marked so far, with *N not marked yet* beside it (on the result page and in **My results**), and each mark you give then shows straight away. Those papers then stop counting as *to mark* - on the home page, the quiz card (its button goes back to **Results**), the *Papers to mark* filter and the Results tab's flag; the test's tile reads *Unmarked, released*, and its Results tab can still filter to them. **More → Hold marks until marking is done** goes back, and they count again; Restart, Reset and Resume turn it off too.

### Email results

Once a test is closed and its marks are released, **Email results** becomes the main button on the test's page (and a step under **Tasks**). It opens the class who handed in, to send each student their own results by email (`src/services/result-mail-service.js`, the email itself in `src/domain/result-mail.js`):

- **Who** - every student who handed in, with their marks and where their email stands: *Not emailed*, *Waiting to send*, *Sending…*, *Emailed 5:20 PM* or *Failed* (with why). Search by name, email or SAP ID, and show **All**, **Not emailed**, **Emailed** or **Failed**. Everyone not emailed yet starts ticked; untick anyone to leave them out, or **Select all shown** / **Clear shown**. Guests (no email) and papers whose marks the student cannot see yet (a short answer still to mark) cannot be ticked, and say why.
- **What it holds** - the test, the teacher's name and **email** (the faculty account that owns the test, as a link to write to them), when it was handed in; their marks and their **rank** in the class ("Rank 3 of 30", equal marks sharing a rank) always; then, as chosen: **their answers** (each question, what they answered and the marks it got - no right or wrong labels), **the correct answers** beside what they did not get right (leave off for a question bank you will reuse), and **how the class did** (the average and the highest mark - never another student's name). A short answer not marked yet shows as *not marked yet*, never 0. **Preview** (the eye) shows any student's email exactly as it will look. **See your full result** in the email opens the student's own result page (they sign in first if they are not signed in).
- **Sending** - the emails go out one at a time in the background, and the list follows them. Each is claimed by one database write, so no student gets the same email twice by accident; one cut off mid-send by a restart is marked *Failed* rather than sent again blindly. A student already emailed can be ticked and sent again.

**The day's allowance.** Brevo's free plan sends 300 emails a day, and sign-in codes use the same allowance. Results emails may use up to `RESULT_MAIL_DAILY_LIMIT` (200) of it, and the codes' limit (`OTP_DAILY_LIMIT`, 295) now counts both, so sign-in codes always keep the rest. The dialog says how many emails are left today; past that, the rest stay *Not emailed* to send another day. Without a Brevo key, a development server writes each email to its log instead of sending it.

## Fullscreen, attempt recovery, and mark release

For each quiz, the admin sets what leaving the test does, under **When a student leaves the test**: two switches, **Warn** and **Lock**, and three numbers. **Exits allowed** and **Total time away** (all absences added up) are free; 0 turns that limit off. Going past either one is a *violation*, counted once per absence. With **Lock** on, **Warnings before lock** says how many violations only warn ("Warning 1 of 2", "Last warning"); the next one locks the attempt until the admin presses Revive, and 0 locks the first time with no warning. **Warn** alone shows a warning on every exit and never locks; with both switches off every exit is only recorded. Tests from before these settings lock with no warning. It can be changed while the test runs; turning Lock off lifts any lock it already has. Exits are logged per attempt either way. Copying, pasting, screenshots, printing and developer tools are blocked, and the student sees a warning, but they never lock. The dashboard shows the exit timeline, lock reason, and total time outside fullscreen, and can revive a locked attempt or restart any attempt from the beginning.

**Going offline is noted, never counted as leaving.** The paper checks in with the server regularly. A silence longer than 60 seconds (`OFFLINE_SECONDS`), from Wi-Fi or data off or a sleeping laptop, is recorded as an offline period — from when, and for about how long — on the student's activity log, in their analysis (*Went offline (not counted)*), on the dashboard row and in both exports. It is not an exit, adds no time away and never locks the paper, so a student on bad Wi-Fi sits the test uninterrupted. Everything the page itself saw meanwhile (switching app, leaving fullscreen) is kept on the device and reported when the connection is back, and counts as usual. The teacher judges the offline periods from the log ([`integrity.js`](src/domain/integrity.js)). Papers from before this still show their offline periods as leaves.

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

The whole app, test pages included, uses one dark theme. Every colour, type size, spacing step, radius and shadow is a token in [`client/src/styles/tokens.css`](client/src/styles/tokens.css), loaded before every other stylesheet; the rest only use `var(--token)`, and `npm run lint:css` refuses raw values. The palette: near-black neutrals (page `#13161C`, cards `#1B1F27`, borders `#2E3440`) with blue as the main colour (`#0B7BBD` behind white text, `#0E95E4` for icons and focus, `#56B8EA` as text). The accents mark the small things: teal for the open view, green for success, pink for highlights, red for danger, orange for warnings such as Block, and yellow for notices and Review. Every text/background pair is at least 4.5:1. Text is Manrope, bundled with the app (no external font request). The **QUIZ.** wordmark, the name in browser tabs and the sign-in line are in [`client/src/brand.js`](client/src/brand.js); the logo and browser-tab icon is [`client/public/logo.svg`](client/public/logo.svg).

**My quizzes** (the admin home) shows totals for quizzes, registrations, average score and attendance (students present per class), then one card per quiz with its registrations, submissions, average score and submission rate. Search by name or code. The **Filter** button (the same panel as the Students and Attendance lists, each option with its count) narrows by status, registration requests waiting, papers to mark, whether students can see their marks yet, and when the quiz was created; it also sorts by created date, title, average score or registrations, either way round ([`test-filters.js`](client/src/screens/admin/test-filters.js)). Each card's menu exports, duplicates (a new, unstarted copy with the same questions and settings, and no students), archives or deletes after a confirmation that can download the results first.

**Archiving** puts a quiz away without deleting anything. It leaves the list until you tick Filter → Archived, leaves every student's **My results** and stops counting on the home page (requests to approve, papers to mark, live tests), whatever it still had pending or unreleased. Restore it and everything comes back as it was.

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

**Download Excel** on the dashboard (**Excel → Export Excel** on the Results tab) gives one workbook. Scores are marks: each question earns what it is worth (see *Marks* below), and every total is out of the paper's full marks. Its sheets:

- **Overview** — registered, started, submitted, average / median / highest / lowest score, average time taken, how many left the test, how many are locked.
- **Results** — one row per student: marks, out of, percentage, rank, time taken, and every integrity count.
- **Marks** — one row per handed-in paper, one column per question, each cell the marks it earned. Yellow cells are short answers still to mark. Change any cell (0 to what the question is worth; Excel refuses anything else) and upload the file with **Excel → Upload marks** on the Results tab. Each row finds its student by a hidden id, else their SAP ID or email. Only cells changed from what the file was exported with are read, so an empty cell, or an older file sent after newer marks were given, changes nothing; a choice question's cell you change becomes your own mark, as in the review pop-up. Total adds each row up as you type, and the upload lists any row or cell it could not use ([`marks-import.js`](src/services/marks-import.js)).
- **Answer grid** — students down, questions across: what each student answered, marked ✓, ✗ or with its part marks, and coloured (green full marks, light green part marks, red none, yellow awaiting a manual mark, grey blank, white not on that student's paper), with the answer key in the first row.
- **Question analysis** — per question: how many papers it was on, answered, blank, correct, incorrect, % correct, and the most common wrong answer.
- **Responses** — one row per student per question: marks earned, out of, when it was answered and how many minutes into the attempt.
- **Integrity log** — every departure, return, copy/paste attempt and lock, in time order.

## Importing a quiz from JSON

In **Create a test**, press **Import questions** beside the title and choose **From a file** (a `.json` file) or **Paste JSON**. The app fills the title, timing, question mix, questions, options and correct answers, and opens the question list for the admin to review and edit everything before creating the quiz. **Download template** saves [`quiz-template.json`](public/quiz-template.json), a working example, and **Copy template** copies it as text to paste wherever the questions are written. Correct answers can be option indexes (starting at `0`) or the exact option text.

**Formatting a question.** The question box in the editor has buttons for **bold**, bullet points and numbered lists (Ctrl+B for bold; Enter starts a new line, and inside a list the next item), and shows a preview of the student's view. It is written as plain text — `**bold**`, `- ` bullets, `1. ` numbers — so a JSON file can use it too. Students see it formatted; spreadsheets get it as plain text with • bullets.

Every key is optional except `questions`; anything left out keeps the form's default.

| Key | Meaning |
|---|---|
| `title`, `instructions` | Text |
| `startsAt` | Start by itself at this time (ISO, e.g. `2026-09-30T10:00:00+05:30`). Leave out to start with the Start button |
| `endsAt` | Submit every paper automatically at this time |
| `durationMinutes` | Or: run this many minutes from the actual start |
| `durationFrom` | `"student"`: count the duration from each student's own Begin instead (the test stays open until closed) |
| `untimed: true` | Or: no clock; ends when the admin presses Close |
| `questionMix` | `{ "mcq": 1, "msq": 1, "short": 1 }` — how many of each type each student gets |
| `questionDraw` | `"spread"` (least overlap) or `"random"` |
| `strictNext` | `false` hides Next under strict timing (default `true`) |
| `strictTiming`, `typeSeconds` | The server holds the paper one question at a time, and the seconds per type (0 = no limit) |
| `strictPrevious` | `true`: students may go back - only on a one-at-a-time paper with no question timers (ignored when any question has a timer) |
| `typeMarks` | What each type is worth: `{ "mcq": 1, "msq": 2, "short": 5 }` (1 each if left out) |
| `questionLayout` | `"one"` (one at a time) or `"all"` (one page); ignored under strict timing |
| `shuffleQuestions`, `allowGuests`, `requirePrivateWindow`, `locationRequired` | `true` / `false` |
| `fullscreenExitLimit`, `fullscreenAbsenceLimitSeconds` | Exits allowed, and seconds away allowed in total (0 = no limit) |
| `warningsBeforeLock` | With `"warn_lock"`: how many times going past a limit only warns before the next time locks (0 = lock at once) |
| `violationAction` | `"lock"` (default: no warnings; past the limit the attempt waits for the admin's Revive), `"record"` (recorded only, no warning or lock), `"warn"` (a warning each time, never locked) or `"warn_lock"` (a numbered warning each time, then the lock after the last one) |
| `resultReleaseMode` | `"instant"`, `"after_quiz"` or `"admin"` |
| `questions[]` | `prompt`, `type` (`mcq` / `msq` / `short`), `options`, `correctOptions`, and optionally `marks` (what this question is worth, if not its type's; a `marks` equal to its type's default follows that default). A choice question has 2 to 10 `options`. A question's own `timeSeconds` is no longer used: times are the test's (`typeSeconds`). A `prompt` may be formatted: `**bold**`, a new line as `\n`, lines starting `- ` for bullet points and `1. ` for a numbered list (the template shows each) |

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
# Optional: results emails a day (of the ~300 shared with sign-in codes), and the pause between two.
RESULT_MAIL_DAILY_LIMIT=200
RESULT_MAIL_GAP_MS=400
ALLOWED_EMAIL_DOMAIN=upes.ac.in
STUDENT_DOMAIN=stu.upes.ac.in
# Optional: only these faculty may open the Users page. Empty = all faculty.
ADMIN_EMAIL=you@ddn.upes.ac.in
```

Without `BREVO_API_KEY`, a development server prints each sign-up or reset code to its console instead of emailing it; a production server (`NODE_ENV=production`) refuses to send.

### Optional class-analysis image in results emails

In **Email results**, **Class analysis image** is off by default. Enabling it attaches a PNG with attempted/absent counts, average, median, highest/lowest marks, papers still to mark, score bands and the marks distribution. It always covers the whole class and all questions, not the current Analysis filters. Unmarked papers are excluded from score statistics and the histogram; mixed paper totals use percentages. The attachment contains no student names, email addresses, SAP IDs or individual results.

Preview shows the generated attachment and offers a download before sending. A text alternative is included in the email. One image render is shared across recipients for each cached class-statistics snapshot. PNG generation uses `@resvg/resvg-js`, installed by `npm install`/`npm ci`; the server needs an installed sans-serif font (minimal Linux containers should include one, such as DejaVu Sans).

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

- The current paper and unsent answers are mirrored to both local storage and IndexedDB. A reload without a connection opens the paper from the device (the sign-in and test checks wait for the connection), and a reload with one puts any unsent answers back in the queue; reconnecting sends only the newest value for each question. A lock, a pause or a venue check that went quiet while offline only holds an answer back — it is sent once the paper is open again, never dropped.
- Answer writes request a compact acknowledgement containing the saved answer and state counters, never the prompts, choices or whole paper. Polls carry the last paper revision and receive an empty `204` when nothing changed.
- Failed answer and submission writes retry with capped exponential jitter. Exit, return and integrity reports use a short batch (exits still leave immediately so a hidden phone cannot suspend them). GPS checks remain immediate by design: replaying an old location later would give a misleading venue decision.
- The paper always shows **Synced**, **Saved on this device**, or **Offline / server unreachable**, so a student knows where an answer currently exists. JSON, HTML, CSS and SVG responses are compressed when large enough to benefit.
- At the shared deadline the page still locks immediately, but the server allows 90 seconds for already queued answers to arrive before automatic finalisation, and the page does not hand the paper in over answers it still holds.
- **Answers that arrive late.** An answer made on the device before its time ran out (the paper's, or a strict question's) but held there by a lost connection is still taken for `LATE_ANSWER_MINUTES` (default 30; 0 turns it off) — only if the server really had not heard from the paper across that end, and only into a paper still open or handed in by the clock or the test's Close. Each one is marked *arrived late* with when the device says it was made and when it came — in the analysis, the marking review, the activity log and the dashboard row — for the teacher to judge against the offline periods ([`late-answers.js`](src/domain/late-answers.js)). The device's time cannot be checked, so this is a record, not a verdict.
- **The clock starts when the question is on screen.** A strict question's clock — and on each-student's-own-time tests, the paper's — starts when the student's device says it is showing it, not when the server sent it, so seconds lost delivering it on a slow connection are given back. It starts no later than `SHOWN_GRACE_SECONDS` (default 10) after sending, so a tampered page gains at most that much. Begin and Next give up on a stuck request after 8 seconds and ask again (both are safe to repeat), and a Next that could not reach the server goes again by itself as soon as the connection is back.
- Timers follow the server's clock, measured from the quickest recent reply (every API reply carries `X-Server-Time`), so a slow reply or a wrong device clock never shows more time than the server counts ([`server-clock.js`](client/src/lib/server-clock.js)).

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
