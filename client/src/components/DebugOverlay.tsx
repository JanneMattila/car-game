import { memo, useEffect, useRef, useState } from 'react';
import { useGameStore } from '../store/gameStore';
import { useNetworkStore } from '../store/networkStore';
import { getReconciliationDebug, getPendingInputCount, getPredictedState } from '../game/clientPrediction';
import './DebugOverlay.css';
import { rendererFrameStats } from '../game/frameStats';

interface DebugOverlayProps {
  localPlayerId: string | null;
}

function DebugOverlay({ localPlayerId }: DebugOverlayProps) {
  const [visible, setVisible] = useState(true);
  const [stats, setStats] = useState({
    ...rendererFrameStats.getStats(),
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
    wallContacts: 0,
    wallCollisionSteps: 0,
    carContacts: 0,
    carCollisionSteps: 0,
  });

  const lastServerCountRef = useRef(0);
  const lastServerHzTimeRef = useRef(performance.now());
  const serverHzRef = useRef(0);

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
    if (!visible) return;
    lastServerCountRef.current = getReconciliationDebug().serverUpdateCount;
    lastServerHzTimeRef.current = performance.now();
    serverHzRef.current = 0;
    const interval = setInterval(() => {
      const debug = getReconciliationDebug();
      const predicted = getPredictedState();
      const { latency } = useNetworkStore.getState();
      const localCar = localPlayerId
        ? useGameStore.getState().cars.get(localPlayerId)
        : null;

      const now = performance.now();

      // Server update Hz
      const hzDelta = now - lastServerHzTimeRef.current;
      let serverHz = serverHzRef.current;
      if (debug.serverUpdateCount < lastServerCountRef.current) {
        lastServerCountRef.current = debug.serverUpdateCount;
        lastServerHzTimeRef.current = now;
        serverHzRef.current = serverHz = 0;
      } else if (hzDelta >= 2000) {
        const newUpdates = debug.serverUpdateCount - lastServerCountRef.current;
        serverHz = Math.round((newUpdates / hzDelta) * 1000);
        lastServerCountRef.current = debug.serverUpdateCount;
        lastServerHzTimeRef.current = now;
        serverHzRef.current = serverHz;
      }

      setStats({
        ...rendererFrameStats.getStats(),
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
        wallContacts: debug.wallContacts,
        wallCollisionSteps: debug.wallCollisionSteps,
        carContacts: debug.carContacts,
        carCollisionSteps: debug.carCollisionSteps,
      });
    }, 100);

    return () => clearInterval(interval);
  }, [localPlayerId, visible]);

  if (!visible) return null;

  const correctionClass =
    stats.correctionDist > 20 ? 'error' :
    stats.correctionDist > 5 ? 'warn' : 'good';

  const fpsClass =
    stats.fps === null ? '' :
    stats.fps < 30 ? 'error' : stats.fps < 50 ? 'warn' : 'good';

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

      <div className="debug-section">
        <div className="debug-section-title">Rendering</div>
        <div className="debug-row">
          <span className="debug-label">FPS</span>
          <span className={`debug-value ${fpsClass}`}>
            {stats.fps?.toFixed(1) ?? '--'}
          </span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Frame time</span>
          <span className="debug-value">{stats.frameTimeMs?.toFixed(1) ?? '--'} ms</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Slowest frame</span>
          <span className="debug-value">{stats.slowestFrameMs?.toFixed(1) ?? '--'} ms</span>
        </div>
      </div>

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
        <div className="debug-section-title">Collisions</div>
        <div className="debug-row">
          <span className="debug-label">Wall contacts</span>
          <span className="debug-value">{stats.wallContacts}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Wall contact steps</span>
          <span className="debug-value">{stats.wallCollisionSteps}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Car contacts</span>
          <span className="debug-value">{stats.carContacts}</span>
        </div>
        <div className="debug-row">
          <span className="debug-label">Car contact steps</span>
          <span className="debug-value">{stats.carCollisionSteps}</span>
        </div>
      </div>

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

export default memo(DebugOverlay);
