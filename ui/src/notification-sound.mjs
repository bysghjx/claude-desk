const sounds = { attention: new Audio(new URL('../sounds/attention.wav', import.meta.url)), complete: new Audio(new URL('../sounds/complete.wav', import.meta.url)) };
for (const sound of Object.values(sounds)) { sound.preload = 'auto'; sound.volume = 0.65; }
window.notificationSound.onPlay(kind => {
  const selected = sounds[kind]; if (!selected) return;
  for (const sound of Object.values(sounds)) { sound.pause(); sound.currentTime = 0; }
  selected.play().catch(() => {});
});
