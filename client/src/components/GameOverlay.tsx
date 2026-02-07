import { useEffect, useState } from 'react';
import './GameOverlay.css';

interface GameOverlayProps {
  text: string;
  color?: string;
}

function GameOverlay({ text, color = '#f59e0b' }: GameOverlayProps) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    setAnimate(false);
    // Trigger reflow to restart animation
    const timer = setTimeout(() => setAnimate(true), 10);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="game-overlay">
      <div 
        className={`overlay-text ${animate ? 'animate' : ''}`}
        style={{ color }}
      >
        {text}
      </div>
    </div>
  );
}

export default GameOverlay;
