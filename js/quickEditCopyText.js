// Personalized copies currently has English and Simplified Chinese copy.
export function copyText(english, chinese) {
  return typeof document !== 'undefined' && /^zh(?:-|$)/i.test(document.documentElement.lang) ? chinese : english;
}
