ALTER TABLE browser_platform_automation_policies
  DROP CONSTRAINT browser_platform_automation_policies_content_voice_check;
--> statement-breakpoint
ALTER TABLE browser_platform_automation_policies
  ADD CONSTRAINT browser_platform_automation_policies_content_voice_check CHECK (
    (
      platform_code = 'douyin'
      AND content_voice IN ('enterprise_official', 'frontline_mover', 'customer_perspective')
    ) OR (
      platform_code <> 'douyin'
      AND content_voice = ''
    )
  );
