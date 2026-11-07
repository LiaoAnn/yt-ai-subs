import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DisplayModeStatus } from "./DisplayModeStatus";
import { QuotaStatus } from "./QuotaStatus";
import {
  DEFAULT_SETTINGS,
  SOURCE_LANGUAGES,
  TARGET_LANGUAGES,
  TRANSLATION_MODELS,
  WHISPER_MODELS,
  loadSettings,
  saveSettings,
  type Settings,
  type SourceLanguage,
  type TargetLanguage,
  type TranslationModel,
  type WhisperModel,
} from "@/shared/settings";
import { trackConfigFromSettings } from "@/shared/track-config";

type Status = "idle" | "saved" | "error";

const trackKey = (settings: Settings) => {
  const { label, languageCode } = trackConfigFromSettings(settings);
  return `${label}\n${languageCode}`;
};

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // Until stored settings have loaded, the form stays disabled: saving early would
  // overwrite them with defaults, and the load would overwrite the user's edits.
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  // The CC-menu track's name as last stored, to tell when a save renames it.
  const [storedTrack, setStoredTrack] = useState("");
  const [renamed, setRenamed] = useState(false);

  useEffect(() => {
    loadSettings().then(
      (stored) => {
        setSettings(stored);
        setStoredTrack(trackKey(stored));
        setLoaded(true);
      },
      () => setStatus("error"),
    );
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    setStatus("idle");
  };

  const onSave = (event: FormEvent) => {
    event.preventDefault();
    if (!loaded) return;
    saveSettings(settings).then(
      () => {
        setStatus("saved");
        const key = trackKey(settings);
        if (key !== storedTrack) setRenamed(true);
        setStoredTrack(key);
      },
      () => setStatus("error"),
    );
  };

  return (
    <main className="w-80 p-3">
      <Card className="gap-4 py-4">
        <CardHeader className="px-4">
          <CardTitle>YT AI Subs</CardTitle>
          <CardDescription>用語音模型產生 YouTube 字幕，可選擇翻譯。</CardDescription>
          <DisplayModeStatus />
        </CardHeader>
        <CardContent className="grid gap-4 px-4">
          <div className="border-b pb-4">
            <QuotaStatus />
          </div>
          <form onSubmit={onSave}>
            <fieldset className="grid gap-4" disabled={!loaded}>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="enabled">開啟 AI 字幕</Label>
                <Switch
                  id="enabled"
                  checked={settings.enabled}
                  onCheckedChange={(enabled) => update({ enabled })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="groq-api-key">Groq API key</Label>
                <Input
                  id="groq-api-key"
                  type="password"
                  autoComplete="off"
                  placeholder="gsk_…"
                  value={settings.groqApiKey}
                  onChange={(event) => update({ groqApiKey: event.target.value.trim() })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="whisper-model">語音辨識模型</Label>
                <Select
                  value={settings.whisperModel}
                  onValueChange={(value) => update({ whisperModel: value as WhisperModel })}
                >
                  <SelectTrigger id="whisper-model" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WHISPER_MODELS.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="source-language">影片語言</Label>
                <Select
                  value={settings.sourceLanguage}
                  onValueChange={(value) => update({ sourceLanguage: value as SourceLanguage })}
                >
                  <SelectTrigger id="source-language" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCE_LANGUAGES.map((language) => (
                      <SelectItem key={language.value} value={language.value}>
                        {language.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="translate">翻譯字幕</Label>
                <Switch
                  id="translate"
                  checked={settings.translate}
                  onCheckedChange={(translate) => update({ translate })}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="target-language">翻譯成</Label>
                <Select
                  value={settings.targetLanguage}
                  disabled={!settings.translate}
                  onValueChange={(value) => update({ targetLanguage: value as TargetLanguage })}
                >
                  <SelectTrigger id="target-language" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TARGET_LANGUAGES.map((language) => (
                      <SelectItem key={language.value} value={language.value}>
                        {language.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="translation-model">翻譯模型</Label>
                <Select
                  value={settings.translationModel}
                  disabled={!settings.translate}
                  onValueChange={(value) => update({ translationModel: value as TranslationModel })}
                >
                  <SelectTrigger id="translation-model" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TRANSLATION_MODELS.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        {model.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="show-original">翻譯上方顯示原文</Label>
                <Switch
                  id="show-original"
                  checked={settings.showOriginal}
                  disabled={!settings.translate}
                  onCheckedChange={(showOriginal) => update({ showOriginal })}
                />
              </div>

              <div className="flex items-center gap-3">
                <Button type="submit">儲存</Button>
                <output className="text-sm text-muted-foreground">
                  {status === "saved" && "已儲存"}
                  {status === "error" && "讀寫設定失敗"}
                </output>
              </div>
              {renamed && (
                <p className="text-xs text-muted-foreground" data-testid="track-rename-note">
                  字幕選單（CC）裡的軌名會在下一部影片或重新整理頁面後更新；字幕內容會照新設定更新。
                </p>
              )}
            </fieldset>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
