import { useEffect, useState } from 'react';
import './Countdown.css';

interface CountdownProps {
  value: number;
}

function Countdown({ value }: CountdownProps) {
  const [animate, setAnimate] = useState(false);

  useEffect(() => {
    setAnimate(false);
    // Trigger reflow to restart animation
    setTimeout(() => setAnimate(true), 10);
  }, [value]);

  const getDisplayValue = () => {
    if (value <= 0) return 'GO!';
    return value.toString();
  };

  const getColor = () => {
    if (value <= 0) return '#10b981'; // green
    if (value === 1) return '#f59e0b'; // yellow
    return '#ef4444'; // red
  };

  return (
    <div className="countdown-overlay">
      <div 
        className={`countdown-value ${animate ? 'animate' : ''}`}
        style={{ color: getColor() }}
      >
        {getDisplayValue()}
      </div>
    </div>
  );
}

export default Countdown;
