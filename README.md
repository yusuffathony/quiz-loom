# QuizLoom 🎯 - Live Multiplayer Quiz Platform

A modern, high-performance real-time quiz platform inspired by Kahoot and Quizizz, built with Node.js, Express, and Socket.IO. Supports 250+ concurrent participants with authoritative server-side timing, speed scoring, answer distribution statistics, and animated winner podiums.

---

## ✨ Features

- **Authoritative Server Timer & Cheat Prevention**: Question answers and countdowns are strictly validated server-side. Correct answers are stripped from participant payloads during questions to prevent inspection cheating.
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
  - Set custom time limits (5–120s) and fun explanations
  - 📥 Export / 📤 Import quizzes as JSON files
- **Immersive User Experience**:
  - Web Audio API synthesized sound effects (correct chime, wrong buzzer, countdown ticks, fanfare) with a mute toggle
  - Live canvas confetti celebrations
  - Responsive layout optimized for mobile and desktop screens
  - Shareable join links (`/?code=ABCDEF`) with one-click clipboard copy

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
```
The server will start at: **http://localhost:3000**

### 3. Run Automated Tests
```bash
npm test
```

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
├── presets.js           # Built-in trivia question packs
├── roomManager.js       # Game state machine, room lifecycle, scoring algorithms
├── server.js            # Express server, Socket.IO handlers, REST API endpoints
├── public/
│   ├── index.html       # Single-page multiplayer UI with Web Audio & Confetti
│   └── vendor/
│       └── socket.io.min.js  # Offline Socket.IO client fallback
├── test/
│   ├── roomManager.test.js   # Unit tests for scoring, room manager, and question logic
│   └── server.test.js        # Integration tests for REST APIs and Socket.IO workflows
└── package.json         # Project metadata and test scripts
```
