import { useEffect, useRef, useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { useNetworkStore } from '../store/networkStore';
import { getReconciliationDebug, getPendingInputCount, getPredictedState } from '../game/clientPrediction';
import './DebugOverlay.css';

interface DebugOverlayProps {
  localPlayerId: string | null;
}

function DebugOverlay({ localPlayerId }: DebugOverlayProps) {
  const [visible, setVisible] = useState(true);
  const [stats, setStats] = useState({
    fps: 0,
    correctionDist: 0,
    correctionX: 0,
    correctionY: 0,
    velDeltaX: 0,
    velDeltaY: 0,
    rotDelta: 0,
    snapped: false,
    serverUpdates: 0,
    serverHz: 0,
    pendingInputs: 0,
    latency: 0,
    predictedX: 0,
    predictedY: 0,
    predictedVx: 0,
    predictedVy: 0,
    speed: 0,
    lap: 0,
    checkpoint: 0,
    finished: false,
    lapTimes: [] as number[],
  });

  const frameCountRef = useRef(0);
  const lastFpsTimeRef = useRef(performance.now());
  const lastServerCountRef = useRef(0);
  const lastServerHzTimeRef = useRef(performance.now());

  // Toggle with B key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (e.code === 'KeyB') {
        setVisible(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // Update stats at ~10Hz
  useEffect(() => {
    const interval = setInterval(() => {
      const debug = getReconciliationDebug();
      const predicted = getPredictedState();
      const { latency } = useNetworkStore.getState();
      const localCar = localPlayerId
        ? useGameStore.getState().cars.get(localPlayerId)
        : null;

      // FPS calculation
      frameCountRef.current++;
      const now = performance.now();
      const fpsDelta = now - lastFpsTimeRef.current;

      let fps = stats.fps;
      if (fpsDelta >= 1000) {
        fps = Math.round((frameCountRef.current / fpsDelta) * 1000);
        frameCountRef.current = 0;
        lastFpsTimeRef.current = now;
      }

      // Server update Hz
      const hzDelta = now - lastServerHzTimeRef.current;
      let serverHz = stats.serverHz;
      if (hzDelta >= 2000) {
        const newUpdates = debug.serverUpdateCount - lastServerCountRef.current;
        serverHz = Math.round((newUpdates / hzDelta) * 1000);
        lastServerCountRef.current = debug.serverUpdateCount;
        lastServerHzTimeRef.current = now;
      }

      setStats({
        fps,
        correctionDist: debug.lastCorrectionDist,
        correctionX: debug.lastCorrectionX,
        correctionY: debug.lastCorrectionY,
        velDeltaX: debug.lastVelocityDeltaX,
        velDeltaY: debug.lastVelocityDeltaY,
        rotDelta: debug.lastRotationDelta,
        snapped: debug.snapped,
        serverUpdates: debug.serverUpdateCount,
        serverHz,
        pendingInputs: getPendingInputCount(),
        latency,
        predictedX: predicted?.x ?? 0,
        predictedY: predicted?.y ?? 0,
        predictedVx: predicted?.vx ?? 0,
        predictedVy: predicted?.vy ?? 0,
        speed: localCar?.speed ?? 0,
        lap: localCar?.lap ?? 0,
        checkpoint: localCar?.checkpoint ?? 0,
        finished: localCar?.finished ?? false,
        lapTimes: localCar?.lapTimes ?? [],
      });
    }, 100);

    return () => clearInterval(interval);
  }, [localPlayerId, stats.fps, stats.serverHz]);

  // Also count render frames for FPS
  useEffect(() => {
    let animId: number;
    const countFrame = () => {
      frameCountRef.current++;
      animId = requestAnimationFrame(countFrame);
    };
    animId = requestAnimationFrame(countFrame);
    return () => cancelAnimationFrame(animId);
  }, []);

  if (!visible) return null;

  const correctionClass =
    stats.correctionDist > 20 ? 'error' :
    stats.correctionDist > 5 ? 'warn' : 'good';

  const velDelta = Math.sqrt(stats.velDeltaX ** 2 + stats.velDeltaY ** 2);
  const velClass = velDelta > 2 ? 'error' : velDelta > 0.5 ? 'warn' : 'good';

  // Visual bar for correction distance (0-50px range)
  const barPct = Math.min(100, (stats.correctionDist / 50) * 100);
  const barColor =
    stats.correctionDist > 20 ? '#ff4444' :
    stats.correctionDist > 5 ? '#ffcc00' : '#00ff88';

  return (
    <div className="debug-overlay">
      <div className="debug-title">DEBUG (B to toggle)</div>

      {/* Reconciliation */}
      <div className="debug-section">
        <div className="debug-section-title">Server Reconciliation</div>
        <div className="debug-row">
          <span className="debug-label">Correction dist</span>
          <span className={`debug-value ${correctionClass}`}>
            {stats.correctionDist.toFixed(2)} px
            {stats.snapped ? ' [SNAP]' : ''}
          </span>
        </div>
        <div className="correction-bar">
          <div className="bar-bg">
            <div
              className="bar-fill"
              style={{ width: `${barPct}%`, backgroundColor: barColor }}
            />
          </div>
        </div>
        <div className="debug-row">
          <span className="debug-label">Correction ΔX/ΔY</span>
          <span className={`debug-value ${correctionClass}`}>
            {stats.correctionX.toFixed(2)} / {stats.correctionY.toFixed(2)}
          </span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Velocity Δ</span>
          <span className={`debug-value ${velClass}`}>
            {velDelta.toFixed(3)} ({stats.velDeltaX.toFixed(2)}, {stats.velDeltaY.toFixed(2)})
          </span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Rotation Δ</span>
          <span className="debug-value">
            {(stats.rotDelta * (180 / Math.PI)).toFixed(2)}°
          </span>
        </div>
      </div>

      {/* Network */}
      <div className="debug-section">
        <div className="debug-section-title">Network</div>
        <div className="debug-row">
          <span className="debug-label">Latency</span>
          <span className={`debug-value ${stats.latency > 100 ? 'error' : stats.latency > 50 ? 'warn' : 'good'}`}>
            {stats.latency.toFixed(0)} ms
          </span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Server updates</span>
          <span className="debug-value">{stats.serverUpdates} (~{stats.serverHz} Hz)</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Pending inputs</span>
          <span className="debug-value">{stats.pendingInputs}</span>
        </div>
      </div>

      {/* Prediction */}
      <div className="debug-section">
        <div className="debug-section-title">Client Prediction</div>
        <div className="debug-row">
          <span className="debug-label">Position</span>
          <span className="debug-value">
            {stats.predictedX.toFixed(1)}, {stats.predictedY.toFixed(1)}
          </span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Velocity</span>
          <span className="debug-value">
            {stats.predictedVx.toFixed(2)}, {stats.predictedVy.toFixed(2)}
          </span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Speed</span>
          <span className="debug-value">{stats.speed.toFixed(2)} px/f</span>
        </div>
      </div>

      {/* Race Progress */}
      <div className="debug-section">
        <div className="debug-section-title">Race Progress</div>
        <div className="debug-row">
          <span className="debug-label">Lap</span>
          <span className="debug-value">{stats.lap}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Checkpoint</span>
          <span className="debug-value">{stats.checkpoint}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Finished</span>
          <span className={`debug-value ${stats.finished ? 'good' : ''}`}>
            {stats.finished ? 'YES' : 'No'}
          </span>
        </div>
        {stats.lapTimes.length > 0 && (
          <div className="debug-row">
            <span className="debug-label">Lap times</span>
            <span className="debug-value">
              {stats.lapTimes.map((t, i) => `L${i + 1}: ${(t / 1000).toFixed(2)}s`).join(', ')}
            </span>
          </div>
        )}
      </div>

      <div className="debug-hint">Press B to hide</div>
    </div>
  );
}

export default DebugOverlay;
