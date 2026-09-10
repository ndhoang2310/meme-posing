export type GameSide = "left" | "right";

export type GameState =
  | "IDLE"
  | "COUNTDOWN"
  | "PLAYING"
  | "PAUSED"
  | "GAME_OVER";

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlayerDetection {
  /** 33 landmarks, crop-local normalized coords 0..1 within the half-frame. */
  landmarks: Landmark[];
  boundingBox: BoundingBox;
  detected: true;
  timestampMs: number;
}

export interface VisionPacket {
  timestampMs: number;
  left: PlayerDetection | null;
  right: PlayerDetection | null;
}

export interface PoseDefinition {
  id: string;
  imageUrl: string;
  targetVector: [number, number, number, number];
  difficulty?: string;
}

export interface GameSnapshot {
  state: GameState;
  score: { left: number; right: number };
  currentPose: PoseDefinition | null;
  roundNumber: number; // 1-based while playing, 0 in IDLE
  totalRounds: number;
  gameRemainingMs: number;
  poseRemainingMs: number;
  countdownRemainingMs: number;
  holdMs: { left: number; right: number };
  similarity: { left: number; right: number };
  winner: "left" | "right" | "draw" | null;
  lastScorer: GameSide | null;
}
