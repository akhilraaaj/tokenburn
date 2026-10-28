import { useMemo } from 'react';
import { ModelTable } from '@/components/model-table';
import { Pills } from '@/components/pills';
import { Card, CardContent } from '@/components/ui/card';
import { useDashboard } from '@/layouts/app-layout';
import { colorMap } from '@/lib/series.ts';
import { DashboardSkeleton, PageHeading, RANGES } from './overview';

export function Models() {
  const { data, error, days, setDays } = useDashboard();
  const colorOf = useMemo(() => colorMap(data?.rows ?? []), [data]);
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!data) return <DashboardSkeleton />;
  return (
    <>
      <PageHeading
        title="Models"
        description="Every model you used, exactly as each tool reported it"
        action={<Pills label="Range" items={RANGES} value={days} onChange={setDays} />}
      />
      <Card className="py-0">
        <CardContent className="px-0">
          <ModelTable rows={data.rows} colorOf={colorOf} tokens costs billing />
        </CardContent>
      </Card>
      <p className="text-xs text-subtle font-medium leading-snug">
        "Auto" means Cursor didn't report which model served the request. * = some requests had no known price.
      </p>
    </>
  );
}
