'use strict';

const CATEGORIES = [
  { slug: 'music', name: 'Singing & Music', emoji: '🎤' },
  { slug: 'dance', name: 'Dance', emoji: '💃' },
  { slug: 'art', name: 'Art & Design', emoji: '🎨' },
  { slug: 'comedy', name: 'Comedy', emoji: '😂' },
  { slug: 'cooking', name: 'Cooking', emoji: '🍳' },
  { slug: 'sports', name: 'Sports & Fitness', emoji: '🏃' },
  { slug: 'teaching', name: 'Teaching', emoji: '📚' },
  { slug: 'coding', name: 'Coding & Tech', emoji: '💻' },
  { slug: 'repairs', name: 'Repairs & DIY', emoji: '🔧' },
  { slug: 'gardening', name: 'Gardening', emoji: '🌱' },
  { slug: 'crafts', name: 'Crafts & Making', emoji: '🧶' },
  { slug: 'everyday', name: 'Everyday Skills', emoji: '🧠' },
];

const CATEGORY_SLUGS = CATEGORIES.map((c) => c.slug);

const REPORT_REASONS = [
  { slug: 'harmful', label: 'Harmful or dangerous content' },
  { slug: 'nudity', label: 'Nudity or sexual content' },
  { slug: 'harassment', label: 'Harassment or hate' },
  { slug: 'spam', label: 'Spam or misleading' },
  { slug: 'copyright', label: 'Copyright violation' },
  { slug: 'other', label: 'Something else' },
];

const REASON_SLUGS = REPORT_REASONS.map((r) => r.slug);

const AVATAR_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#06b6d4', '#8b5cf6', '#ef4444', '#14b8a6',
];

module.exports = { CATEGORIES, CATEGORY_SLUGS, REPORT_REASONS, REASON_SLUGS, AVATAR_COLORS };
