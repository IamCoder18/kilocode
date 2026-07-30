import { Component } from "solid-js"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Card } from "@kilocode/kilo-ui/card"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import SettingsRow from "./SettingsRow"

const BrowserTab: Component = () => {
  const { config, updateConfig } = useConfig()
  const { t } = useLanguage()
  const enabled = () => config().experimental?.world_browser !== false
  const headless = () => config().world?.browser?.headless ?? true

  const setEnabled = (value: boolean) => {
    updateConfig({ experimental: { ...config().experimental, world_browser: value } })
  }

  const setHeadless = (value: boolean) => {
    updateConfig({ world: { ...config().world, browser: { ...config().world?.browser, headless: value } } })
  }

  return (
    <div style={{ display: "flex", "flex-direction": "column", gap: "16px" }}>
      <Card>
        <SettingsRow title={t("settings.browser.enable.title")}>
          <Switch checked={enabled()} onChange={setEnabled} hideLabel>
            {t("settings.browser.enable.title")}
          </Switch>
        </SettingsRow>

        <SettingsRow
          title={t("settings.browser.headless.title")}
          description={t("settings.browser.headless.description")}
          last
        >
          <Switch checked={headless()} onChange={setHeadless} hideLabel>
            {t("settings.browser.headless.title")}
          </Switch>
        </SettingsRow>
      </Card>
    </div>
  )
}

export default BrowserTab
