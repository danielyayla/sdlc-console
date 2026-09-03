export function Placeholder({ title, item }: { title: string; item: string }) {
  return (
    <div className="placeholder">
      <div className="eyebrow">{title}</div>
      <p>This view arrives with build-order item {item}.</p>
    </div>
  );
}
