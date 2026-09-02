ALTER TABLE browser_platform_automation_policies
  ADD COLUMN content_voice varchar(32) NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE browser_platform_automation_policies
SET content_voice = 'enterprise_official'
WHERE platform_code = 'douyin';
--> statement-breakpoint
ALTER TABLE browser_platform_automation_policies
  ADD CONSTRAINT browser_platform_automation_policies_content_voice_check CHECK (
    (
      platform_code = 'douyin'
      AND content_voice IN ('enterprise_official', 'frontline_mover')
    ) OR (
      platform_code <> 'douyin'
      AND content_voice = ''
    )
  );
