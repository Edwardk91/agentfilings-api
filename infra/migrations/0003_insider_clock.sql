-- Track when Form 4 data was last fetched, separately from company metadata.
--
-- Refreshing a ticker's metadata costs 2 SEC requests; refreshing its insider data
-- costs up to 50 more. At SEC's 10 req/s ceiling that is ~9 minutes for the whole
-- corpus versus ~3 hours, so the two cannot share a schedule — and therefore cannot
-- share a timestamp. With one column the cheap daily pass stamps every row `now()`
-- and the expensive insider rotation can never find anything to do.

alter table companies add column if not exists insiders_updated_at timestamptz;

-- Every existing row was synced with insiders enabled (the default), so its insider
-- data is exactly as old as its metadata. Seeding from `updated_at` rather than null
-- avoids the first rotation treating the entire corpus as never-fetched.
update companies set insiders_updated_at = updated_at where insiders_updated_at is null;

-- Deliberately no index: the table is ~2,900 rows and the rotation query runs twice a
-- day. A sequential scan is faster than the write cost of maintaining an index that
-- every sync would have to update.
