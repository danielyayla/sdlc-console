/** A flat plane at the bottom centre with a champagne hairline on top; the text is the whole message. */
export function Toast({ text }: { text: string }) {
  return (
    <div className="toast" role="status">
      {text}
    </div>
  );
}
