# QuizLoom - Live Quiz App

Live quiz platform like Kahoot/Quizizz supporting 250+ concurrent participants.

## Features
- Host quiz with 6-letter code
- Multiple question types: Quiz, Multi-choice, True/False, Open
- Real-time scoring & leaderboard
- 250+ participants supported

## Setup

```bash
npm install
npm start
```

## Usage
1. **Host** creates a room → gets a 6-letter code
2. **Participants** join with the code
3. Host starts the game → real-time scoring & leaderboard

## Tech Stack
- Node.js + Express + Socket.IO
- No database (in-memory) - production-ready with Redis/MongoDB
