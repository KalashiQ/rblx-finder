export interface Game {
  source_id: string;
  title: string;
  url: string;
  ccu?: number;
}

export interface GameWithStatus {
  source_id: string;
  title: string;
  url: string;
  isNew: boolean;
}
