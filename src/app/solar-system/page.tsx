export const metadata = {
  title: 'Cosmic Explorer — OSIRIS',
  description: 'Multi-scale cosmic explorer: Earth, Solar System, Milky Way, Observable Universe.',
};

export default function SolarSystemPage() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#05080d',
        overflow: 'hidden',
      }}
    >
      <iframe
        src="/solar-system.html"
        title="OSIRIS Cosmic Explorer"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
        }}
        allow="accelerometer; fullscreen"
      />
    </div>
  );
}
