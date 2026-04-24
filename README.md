# ⛳ Looper — The Yardage Book

A quiet, voice-first golf companion. Scorecard, caddy, tee times — styled like a printed yardage book rather than a SaaS app.

![Golf Scorecard App](https://img.shields.io/badge/Golf-Scorecard-green?style=for-the-badge)

## Features

- **📝 Score Tracking** - Enter scores hole-by-hole with tap-to-edit grid
- **👥 Multi-Player** - Track up to 6 players per round
- **📷 OCR Scanning** - Snap a photo of a physical scorecard to auto-fill scores
- **🏌️ Course Management** - Pre-loaded famous courses + create custom courses
- **📊 Live Totals** - Front 9, Back 9, and total with +/- par calculation
- **🎨 Score Colors** - Visual indicators for eagle, birdie, par, bogey, etc.
- **📱 PWA** - Install on your phone like a native app
- **💾 Offline First** - All data stored locally in your browser

## Quick Start

### Development

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Open http://localhost:3000
```

### Production Build

```bash
npm run build
npm start
```

## Tech Stack

- **Framework:** Next.js 14 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS
- **Storage:** LocalStorage (no backend required)
- **OCR:** OpenAI GPT-4 Vision API

## Architecture

```
src/
├── app/
│   ├── page.tsx           # Home - list rounds
│   ├── round/
│   │   ├── new/           # Create new round
│   │   └── [id]/          # Score entry
│   └── settings/          # API key config
├── components/
│   ├── ScoreGrid.tsx      # Score entry grid
│   └── CameraCapture.tsx  # Photo capture for OCR
└── lib/
    ├── types.ts           # Data models
    ├── storage.ts         # LocalStorage persistence
    └── ocr.ts             # OpenAI Vision integration
```

## Data Models

```typescript
interface Round {
  id: string;
  courseName: string;
  date: string;
  players: Player[];
  scores: Score[];
  holes: HoleInfo[];
  status: 'active' | 'completed';
}

interface Score {
  playerId: string;
  holeNumber: number;
  strokes: number | null;
}
```

## OCR Setup

The scorecard scanning feature uses OpenAI's GPT-4 Vision API.

1. Get an API key from [platform.openai.com](https://platform.openai.com/api-keys)
2. Go to Settings in the app
3. Enter your API key
4. Start scanning scorecards!

**Note:** API calls are made directly from the browser. Your key is stored in localStorage and never sent to our servers.

## Usage

### Starting a Round

1. Tap "Start New Round"
2. Select a course or create a custom one
3. Add player names (1-6 players)
4. Tap "Start Round"

### Entering Scores

- Tap any cell in the score grid
- Use the number pad or keyboard to enter strokes
- Scores auto-advance to next player/hole
- Tap "Done" to close the input pad

### Scanning a Scorecard

1. Tap the 📷 button
2. Take a photo of your paper scorecard
3. The app will use OCR to extract scores
4. Review and confirm the imported scores

**Tips for best OCR results:**
- Good lighting
- Flat, unwrinkled scorecard
- Clear, legible handwriting
- Include player names in the photo

## Deploy

### Vercel (Recommended)

```bash
npm i -g vercel
vercel
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

## Future Enhancements

- [ ] Course database search
- [ ] Statistics & trends
- [ ] Handicap tracking
- [ ] Social sharing
- [ ] GPS hole flyovers
- [ ] Offline PWA with service worker
- [ ] Export rounds to CSV

## License

MIT

---

Built with ☕ and ⛳ by [justslee](https://github.com/justslee)
