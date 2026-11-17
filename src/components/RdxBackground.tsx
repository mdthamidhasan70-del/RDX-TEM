import { useEffect, useRef } from 'react';

export function RdxEmblem({ className = 'w-12 h-12' }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="rdx-emblem-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff6b6b" />
          <stop offset="55%" stopColor="#ef4444" />
          <stop offset="100%" stopColor="#b91c1c" />
        </linearGradient>
      </defs>
      <polygon
        points="32,4 58,18 58,46 32,60 6,46 6,18"
        fill="rgba(239,68,68,0.08)"
        stroke="url(#rdx-emblem-grad)"
        strokeWidth="3.2"
        strokeLinejoin="round"
      />
      <path
        d="M21 44V20h12.5c5.4 0 8.9 3.1 8.9 7.8 0 3.7-2.1 6.3-5.6 7.3L43.5 44h-7.2l-5.6-8.1h-3.5V44H21zm6.2-13.4h5.4c2.3 0 3.7-1.1 3.7-2.8s-1.4-2.7-3.7-2.7h-5.4v5.5z"
        fill="url(#rdx-emblem-grad)"
      />
    </svg>
  );
}

export function RdxBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const count = window.innerWidth < 768 ? 30 : 58;

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      alpha: number;
    }

    let particles: Particle[] = [];

    const makeParticle = (): Particle => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.36 * dpr,
      vy: (Math.random() - 0.5) * 0.36 * dpr,
      r: (Math.random() * 1.5 + 0.6) * dpr,
      alpha: Math.random() * 0.45 + 0.18,
    });

    const resize = () => {
      w = canvas.width = window.innerWidth * dpr;
      h = canvas.height = window.innerHeight * dpr;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      particles = Array.from({ length: count }, makeParticle);
    };

    resize();
    window.addEventListener('resize', resize);

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;

        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
        grad.addColorStop(0, `hsla(0, 85%, 60%, ${p.alpha})`);
        grad.addColorStop(1, 'hsla(0, 85%, 60%, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.strokeStyle = 'rgba(239, 68, 68, 0.05)';
      ctx.lineWidth = 1;
      const maxDist = 125 * dpr;
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.hypot(dx, dy);
          if (dist < maxDist) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.stroke();
          }
        }
      }

      animId = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <>
      <div
        className="fixed inset-0 -z-40 pointer-events-none"
        style={{
          background:
            'radial-gradient(1100px 700px at 12% -10%, rgba(239,68,68,0.18), transparent 60%), radial-gradient(1000px 700px at 95% 115%, rgba(16,185,129,0.14), transparent 60%), #080000',
        }}
      >
        <div className="absolute inset-0 rdx-grid-bg" />
      </div>
      <div
        className="fixed -top-[120px] -right-[120px] w-[420px] h-[420px] rounded-full blur-[90px] pointer-events-none -z-20 animate-orb-1"
        style={{ background: 'rgba(239, 68, 68, 0.28)' }}
      />
      <div
        className="fixed -bottom-[90px] -left-[90px] w-[360px] h-[360px] rounded-full blur-[90px] pointer-events-none -z-20 animate-orb-2"
        style={{ background: 'rgba(16, 185, 129, 0.24)' }}
      />
      <div
        className="fixed top-[45%] left-[32%] w-[320px] h-[320px] rounded-full blur-[90px] pointer-events-none -z-20 animate-orb-3"
        style={{ background: 'rgba(20, 184, 166, 0.18)' }}
      />
      <canvas ref={canvasRef} className="fixed inset-0 -z-30 pointer-events-none opacity-65" />
    </>
  );
}
