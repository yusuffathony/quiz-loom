# QuizLoom 🎯 - Live Multiplayer Quiz Platform

A high-performance real-time multiplayer quiz platform inspired by Kahoot and Quizizz, engineered to run on **Cloudflare Workers**, **Cloudflare Durable Objects**, **Cloudflare D1**, and **Native WebSockets**.

Supports 250+ concurrent participants with authoritative server-side timing, speed scoring, answer distribution statistics, and animated winner podiums.

---

## 🏗️ Architecture

```
                                  [ Cloudflare Global Network ]
                                                │
                          ┌─────────────────────┴─────────────────────┐
                          ▼                                           ▼
                 [ Cloudflare Assets ]                     [ Cloudflare Worker ]
                  (public/index.html)                          (src/index.js)
                 Zero External Scripts                         Routes & APIs
                          │                                           │
                          │ Upgrade: WebSocket                        │
                          └─────────────────────┬─────────────────────┘
                                                ▼
                                    [ Cloudflare Durable Object ]
                                            (src/room.js)
                                  Single Coordination Point Per Room
                                  • Native WebSockets (Hibernation)
                                  • Authoritative Timer Countdown
                                  • Real-Time Broadcast & Scoring
                                                │
                                                ▼  (Game Over Save)
                                      [ Cloudflare D1 Database ]
                                              (schema.sql)
                                   • Persistent Quizzes & Questions
                                   • Game Session Leaderboard Archives
```

---

## ✨ Features

- **Cloudflare Edge Deployment**:
  - **Durable Objects (`QuizRoom`)**: Single-point-of-coordination per room code. Handles WebSocket Hibernation, live player state, broadcasts, and countdowns.
  - **Cloudflare D1**: Serverless SQLite database storing custom quizzes, questions, and historical game results.
  - **Native WebSockets**: Zero external script dependencies (`socket.io` removed). Uses 100% standard browser `WebSocket`.
- **User Authentication & Cloud Question Bank**:
  - Secure user registration and login with salt + PBKDF2 SHA-256 password hashing via standard Web Crypto API.
  - Persistent user sessions via Bearer tokens.
  - **Question Preparation & Library ("My Quizzes")**: Prepare questions ahead of time, save them to your personal question bank in Cloudflare D1, edit or reorder them, and load them into live game rooms anytime with 1 click!
  - Seamless Host Lobby integration with instant switching between preset packs and personal prepared quizzes.
- **Authoritative Server Timer & Cheat Prevention**:
  - Server-side 1-second timer loop.
  - Correct answers are stripped from participant payloads during questions to prevent client inspection cheating.
- **Dynamic Speed & Streak Scoring**:
  - Base points: 500
  - Speed bonus: Up to +500 points depending on response speed
  - Streak bonus: Up to +500 points for consecutive correct answers
- **Multiple Question Types**:
  - **Single Choice (Quiz)**: 4 colored cards with distinctive geometric shapes (▲ Red, ◆ Blue, ● Yellow, ■ Green)
  - **True / False**: Fast 2-option verification
  - **Short Answer (Open Text)**: Case-insensitive text matching
- **4 Built-in Preset Quizzes**:
  - 🌐 Web Development & Tech Trivia
  - 🔬 Science & Cosmos
  - 🌍 World Geography & Wonders
  - 💡 General Knowledge & Pop Culture
- **In-App Custom Quiz Builder**:
  - Add, edit, or delete questions directly from the Host Lobby
  - Set custom time limits (1–120s) and fun explanations
  - 📥 Export / 📤 Import quizzes as JSON files
- **Immersive User Experience**:
  - Web Audio API synthesized sound effects (correct chime, wrong buzzer, countdown ticks, fanfare) with a mute toggle
  - Live canvas confetti celebrations
  - Responsive layout optimized for mobile and desktop screens
  - Shareable join links (`/?code=ABCDEF`) with one-click clipboard copy

---

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Automated Test Suite (17 Tests)
```bash
npm test
```

### 3. Initialize Local Cloudflare D1 Database
```bash
npm run d1:migrate
```

### 4. Start Local Cloudflare Worker & Durable Objects
```bash
npm run dev
```
Wrangler will launch local Miniflare simulation at: **http://localhost:8787**

---

## ☁️ Deploying to Cloudflare Workers

### 1. Login to Cloudflare
```bash
npx wrangler login
```

### 2. Create your Production D1 Database
```bash
npx wrangler d1 create quiz-loom-db
```
Copy the `database_id` output and update `d1_databases[0].database_id` inside [wrangler.jsonc](file:///c:/Users/USER/Documents/xampp/htdocs/quiz-loom/quiz-loom/wrangler.jsonc).

### 3. Run Production Database Migrations
```bash
npm run d1:migrate:prod
```

### 4. Deploy Worker, Durable Objects & Assets
```bash
npm run deploy
```
Your live quiz platform is now deployed globally across Cloudflare's network!

---

## 🎮 How to Play

### As a Host:
1. Click **Host a Quiz** on the home screen.
2. Enter your host nickname (e.g. `Quizmaster`).
3. Share the generated **6-character Room Code** or click **Copy Link**.
4. Choose a preset quiz pack from the lobby or click **Builder** to customize questions.
5. Click **Start Quiz** once players have joined!
6. Control the game: skip timers, view answer distributions, advance questions, and reveal the final podium.

### As a Participant:
1. Open the URL on a mobile device or desktop browser.
2. Click **Join a Game** and enter the 6-character room code.
3. Enter a nickname or tap 🎲 for a random name.
4. Answer questions on your screen before the timer expires to rack up speed and streak bonuses!

---

## 📁 Project Structure

```
quiz-loom/
├── wrangler.jsonc       # Cloudflare Workers, Durable Objects, and D1 configuration
├── schema.sql           # D1 SQL database schema
├── src/
│   ├── index.js         # Cloudflare Worker router (HTTP & WebSocket upgrades)
│   ├── room.js          # QuizRoom Durable Object (WebSockets, Timer, D1 save)
│   └── gameLogic.js     # Pure scoring, answer checking, and sanitization
├── public/
│   └── index.html       # Single-page UI with Native WebSockets, Web Audio & Confetti
├── presets.js           # Built-in trivia question packs
├── test/
│   ├── cloudflare.test.js    # Tests for Cloudflare Worker, Durable Object & D1
│   ├── encoding.test.js      # Tests for packet serialization
│   ├── roomManager.test.js   # Unit tests for scoring and room management
│   ├── server.test.js        # Integration tests for server flows
│   └── timer.test.js         # Tests for authoritative countdown timer
└── package.json         # Project metadata, scripts, and dependencies
```
