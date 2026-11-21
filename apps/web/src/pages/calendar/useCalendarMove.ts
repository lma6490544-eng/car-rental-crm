import type { MovePreview } from '../../contracts';
import { useCallback, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
export function useCalendarMove() {
  const [moveRequest, setMoveRequest] = useState<{
    bookingId: number;
    vehicleId: number;
    startAt: string;
  } | null>(null);
  const [movePreview, setMovePreview] = useState<MovePreview>();
  const [moveError, setMoveError] = useState('');
  const [moveLoading, setMoveLoading] = useState(false);
  const moveSequence = useRef(0);
  const loadMove = useCallback(
    async (request: { bookingId: number; vehicleId: number; startAt: string }) => {
      const sequence = ++moveSequence.current;
      setMoveRequest(request);
      setMovePreview(undefined);
      setMoveError('');
      setMoveLoading(true);
      try {
        const preview = await api<MovePreview>('/bookings/' + request.bookingId + '/move/preview', {
          method: 'POST',
          body: { vehicleId: request.vehicleId, startAt: request.startAt },
        });
        if (moveSequence.current === sequence) setMovePreview(preview);
      } catch (e) {
        if (moveSequence.current === sequence) setMoveError(errorMessage(e));
      } finally {
        if (moveSequence.current === sequence) setMoveLoading(false);
      }
    },
    [],
  );
  const closeMove = () => {
    moveSequence.current++;
    setMoveRequest(null);
    setMovePreview(undefined);
    setMoveError('');
  };

  return { moveRequest, movePreview, moveError, moveLoading, loadMove, closeMove };
}
