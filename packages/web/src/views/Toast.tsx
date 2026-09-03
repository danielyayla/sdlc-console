export function Toast({ text }: { text: string }) {
  return (
    <div className="toast" role="status">
      <span className="check">✓</span>
      <span>{text}</span>
    </div>
  );
}
