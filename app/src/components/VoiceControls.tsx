export function VoiceControls({ readAloud, handsFree, onReadAloud, onHandsFree, micAvailable }: {
  readAloud: boolean; handsFree: boolean; onReadAloud: () => void; onHandsFree: () => void; micAvailable: boolean;
}) {
  return (
    <>
      <button className={`pill${readAloud ? ' on' : ''}`} onClick={onReadAloud} aria-pressed={readAloud} title="Speak every reply">Read aloud</button>
      {micAvailable && <button className={`pill${handsFree ? ' on' : ''}`} onClick={onHandsFree} aria-pressed={handsFree} title="After a spoken reply, listen again automatically">Hands-free</button>}
    </>
  );
}
