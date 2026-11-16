'use client';
/** App check-in / check-out inside the branch boundary with a selfie. Location is read only now. */
import { useRef, useState } from 'react';
import { useApp } from '@/lib/app';
import { post, uploadFile } from '@/lib/api';
import { Button, Card, DateText, ErrorBox, StatusBadge, useAction } from './ui';

export function CheckInCard({ attendance, onDone }: { attendance: { check_in_at: string | null; check_out_at: string | null; status: string } | null; onDone: () => void }) {
  const { t } = useApp();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<'in' | 'out'>('in');
  const a = useAction();

  const position = () =>
    new Promise<GeolocationPosition>((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('no_geolocation'));
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000 });
    });

  async function go(file?: File) {
    await a.run(async () => {
      const pos = await position().catch(() => {
        throw Object.assign(new Error('location_denied'), { code: 'location_denied' });
      });
      const selfie = file ? await uploadFile(file, 'selfie') : null;
      await post('/attendance/check', { kind, lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy_m: pos.coords.accuracy, selfie_path: selfie });
      onDone();
    });
  }

  return (
    <Card title={t('attendance.today')}>
      {attendance?.check_in_at ? (
        <div className="space-y-1 text-sm">
          <div>
            {t('attendance.checkedInAt')} <DateText value={attendance.check_in_at} withTime /> <StatusBadge status={attendance.status} />
          </div>
          {attendance.check_out_at && (
            <div>
              {t('attendance.checkedOutAt')} <DateText value={attendance.check_out_at} withTime />
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">{t('attendance.notCheckedIn')}</p>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void go(f);
          e.target.value = '';
        }}
      />
      <div className="mt-3 flex gap-2">
        {!attendance?.check_in_at && (
          <Button
            disabled={a.busy}
            onClick={() => {
              setKind('in');
              fileRef.current?.click();
            }}
          >
            {t('attendance.checkIn')}
          </Button>
        )}
        {attendance?.check_in_at && !attendance.check_out_at && (
          <Button
            variant="secondary"
            disabled={a.busy}
            onClick={() => {
              setKind('out');
              void go();
            }}
          >
            {t('attendance.checkOut')}
          </Button>
        )}
      </div>
      <div className="mt-2">
        <ErrorBox error={a.error} />
      </div>
    </Card>
  );
}
