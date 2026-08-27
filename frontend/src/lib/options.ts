// Render option setups in a human-readable format, e.g. "June 22, 2026, $300 Call".

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export function formatExpiration(iso?: string, label?: string): string {
  if (label) return label;
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** "June 26, 2026, $380 Call" */
export function formatOption(setup: any): string {
  if (!setup) return '';
  if (setup.readable) return setup.readable;
  const exp = formatExpiration(setup.expiration, setup.expiration_label);
  const strike = setup.strike != null ? `$${setup.strike}` : '';
  const type = setup.option_type ? setup.option_type[0].toUpperCase() + setup.option_type.slice(1) : '';
  return [exp, [strike, type].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/** Short label from a bot's action JSON when no concrete strike is set. */
export function optionLabelFromAction(action: any): string {
  if (!action?.option_type) return '';
  const tgt = action.strike_target ? `${action.strike_target.toUpperCase()} ` : '';
  const exp = action.expiration ? action.expiration : '';
  return `${tgt}${action.option_type}${exp ? ` · ${exp}` : ''}`;
}
