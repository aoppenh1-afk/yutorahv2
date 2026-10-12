'use client';

import { createContext, useContext, useState } from 'react';

const PlayerDialogContext = createContext<{
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
} | null>(null);

export function PlayerDialogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <PlayerDialogContext.Provider value={{ expanded, setExpanded }}>
      {children}
    </PlayerDialogContext.Provider>
  );
}

export function usePlayerDialog() {
  const dialog = useContext(PlayerDialogContext);
  if (!dialog) throw new Error('Player dialog provider is missing.');
  return dialog;
}
