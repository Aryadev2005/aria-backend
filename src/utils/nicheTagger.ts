// src/utils/nicheTagger.ts
// Shared niche tag derivation from free-text — used by all discovery scrapers.

export function deriveNicheTags(text: string): string[] {
  const t = text.toLowerCase();
  const tags: string[] = [];
  if (/beauty|makeup|skincare|lipstick|foundation|serum|moistur|haircare|nail/.test(t)) tags.push('beauty');
  if (/fashion|outfit|style|ootd|clothing|wardrobe|dress|shoe|bag|luxury/.test(t)) tags.push('fashion');
  if (/fitness|workout|gym|exercise|yoga|diet|nutrition|protein|weight/.test(t)) tags.push('fitness');
  if (/food|recipe|cook|bake|restaurant|cuisine|meal|snack|drink|coffee/.test(t)) tags.push('food');
  if (/finance|stock|invest|market|crypto|bitcoin|nifty|sensex|mutual|trading/.test(t)) tags.push('finance');
  if (/tech|software|app|phone|iphone|android|ai|gadget|laptop|computer/.test(t)) tags.push('tech');
  if (/gaming|game|esport|stream|twitch|playstation|xbox|nintendo/.test(t)) tags.push('gaming');
  if (/travel|tour|trip|holiday|flight|hotel|destination|visa|backpack/.test(t)) tags.push('travel');
  if (/education|study|exam|learn|course|tutor|school|college|university/.test(t)) tags.push('education');
  if (/sport|cricket|football|soccer|nba|ipl|tennis|athlete|match/.test(t)) tags.push('sports');
  if (/music|song|artist|album|playlist|concert|singer|rap|pop|bollywood/.test(t)) tags.push('music');
  if (/health|wellness|mental|therapy|doctor|hospital|medicine|covid|vaccine/.test(t)) tags.push('health');
  if (/comedy|meme|funny|humor|laugh|parody|sketch/.test(t)) tags.push('entertainment');
  if (/parenting|baby|pregnancy|mom|dad|family|child|toddler/.test(t)) tags.push('parenting');
  if (/pet|dog|cat|animal|wildlife|adoption/.test(t)) tags.push('pets');
  if (/automotive|car|bike|ev|electric|motor|vehicle|drive/.test(t)) tags.push('automotive');
  if (/diy|home|decor|interior|garden|renovation|furniture|craft/.test(t)) tags.push('lifestyle');
  if (tags.length === 0) tags.push('general');
  return [...new Set(tags)];
}
