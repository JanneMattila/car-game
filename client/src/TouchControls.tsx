import { useTouchInput } from '../game/InputHandler';
import './TouchControls.css';

function TouchControls() {
  const {
    showTouchControls,
    handleAccelerateStart,
    handleAccelerateEnd,
    handleBrakeStart,
    handleBrakeEnd,
    handleLeftStart,
    handleLeftEnd,
    handleRightStart,
    handleRightEnd,
  } = useTouchInput();

  if (!showTouchControls) return null;

  return (
    <div className="touch-controls">
      {/* Left side - Steering */}
      <div className="touch-steering">
        <button
          className="touch-btn steer-left"
          onTouchStart={handleLeftStart}
          onTouchEnd={handleLeftEnd}
          onMouseDown={handleLeftStart}
          onMouseUp={handleLeftEnd}
        >
          ◄
        </button>
        <button
          className="touch-btn steer-right"
          onTouchStart={handleRightStart}
          onTouchEnd={handleRightEnd}
          onMouseDown={handleRightStart}
          onMouseUp={handleRightEnd}
        >
          ►
        </button>
      </div>

      {/* Right side - Pedals */}
      <div className="touch-pedals">
        <button
          className="touch-btn brake"
          onTouchStart={handleBrakeStart}
          onTouchEnd={handleBrakeEnd}
          onMouseDown={handleBrakeStart}
          onMouseUp={handleBrakeEnd}
        >
          BRAKE
        </button>
        <button
          className="touch-btn accelerate"
          onTouchStart={handleAccelerateStart}
          onTouchEnd={handleAccelerateEnd}
          onMouseDown={handleAccelerateStart}
          onMouseUp={handleAccelerateEnd}
        >
          GAS
        </button>
      </div>
    </div>
  );
}

export default TouchControls;
