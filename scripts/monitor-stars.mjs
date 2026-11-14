import { execSync } from 'node:child_process';

const TARGET_STARS = 16;
const REPO = 'zisam-glitch/kvdock';

export async function checkStars() {
  try {
    const raw = execSync(`gh api repos/${REPO} --jq '{stars: .stargazers_count, watchers: .subscribers_count, forks: .forks_count}'`, {
      encoding: 'utf-8',
    }).trim();

    const data = JSON.parse(raw);
    const count = data.stars;
    const remaining = Math.max(0, TARGET_STARS - count);
    const progress = Math.min(100, Math.round((count / TARGET_STARS) * 100));

    const stargazersRaw = execSync(`gh api repos/${REPO}/stargazers --jq '[.[].login]'`, {
      encoding: 'utf-8',
    }).trim();
    const stargazers = JSON.parse(stargazersRaw);

    const progressBarWidth = 20;
    const filled = Math.round((progress / 100) * progressBarWidth);
    const bar = '█'.repeat(filled) + '░'.repeat(progressBarWidth - filled);

    console.log(`========================================`);
    console.log(`⭐ KVDock Starstruck Tracker: ${count}/${TARGET_STARS} stars (${progress}%)`);
    console.log(`Progress: [${bar}]`);
    console.log(`Remaining to unlock badge: ${remaining} star(s)`);
    console.log(`Current Stargazers (${stargazers.length}): ${stargazers.join(', ') || 'None'}`);
    console.log(`========================================`);

    if (count >= TARGET_STARS) {
      console.log(`🎉 CONGRATULATIONS! Starstruck achievement criteria met (${count} stars)!`);
      console.log(`GitHub will display the badge on your profile within 24-48 hours.`);
    }

    return { count, remaining, progress, stargazers };
  } catch (err) {
    console.error('Error fetching stars via gh CLI:', err.message);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith('monitor-stars.mjs')) {
  checkStars();
}
