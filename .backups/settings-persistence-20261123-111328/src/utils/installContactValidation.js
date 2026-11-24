import {
  EMAIL_PATTERN,
  GSTIN_PATTERN,
  getContactValidationType,
  normalizeGSTINInput,
  validateContactField
} from '../../shared/fieldValidation.js';

const FIELD_SELECTOR = 'input:not([type="hidden"]):not([disabled])';

const inputValidationType = (input) => {
  if (input.type === 'search' || input.classList.contains('search-input') || input.closest('.employee-search-select, .customer-search-select, .search-input')) return null;
  if (/^search\b/i.test(input.getAttribute('placeholder') || '')) return null;
  if (input.dataset.erpValidationType) return input.dataset.erpValidationType;
  const fieldText = [
    input.name,
    input.id,
    input.getAttribute('aria-label'),
    input.getAttribute('placeholder'),
    input.closest('label')?.textContent,
    input.closest('.form-field, .field-group, .field-row')?.textContent
  ].filter(Boolean).join(' ');
  if (input.type === 'email') return 'email';
  if (input.type === 'tel' && !/extension|ext\.?\s*number/i.test(fieldText)) return 'phone';
  return getContactValidationType(fieldText);
};

const validationMessage = (input, type) => validateContactField(type, input.value, { required: input.required });

const getMessageNode = (input) => {
  const id = input.dataset.erpValidationMessageId;
  if (id) return document.getElementById(id);
  const message = document.createElement('span');
  const messageId = `erp-validation-${Math.random().toString(36).slice(2)}`;
  message.id = messageId;
  message.className = 'erp-field-validation-error';
  message.setAttribute('role', 'alert');
  message.hidden = true;
  input.dataset.erpValidationMessageId = messageId;
  input.insertAdjacentElement('afterend', message);
  const describedBy = input.getAttribute('aria-describedby');
  input.setAttribute('aria-describedby', [describedBy, messageId].filter(Boolean).join(' '));
  return message;
};

const showValidation = (input, type, visible = true) => {
  const messageText = validationMessage(input, type);
  input.setCustomValidity(messageText || '');
  const node = getMessageNode(input);
  node.textContent = messageText || '';
  node.hidden = !visible || !messageText;
  input.setAttribute('aria-invalid', messageText ? 'true' : 'false');
  return !messageText;
};

const validateContainer = (container) => {
  if (!container) return [];
  return [...container.querySelectorAll(FIELD_SELECTOR)].filter((input) => {
    prepareInput(input);
    const type = input.dataset.erpValidationType;
    return type && !showValidation(input, type, true);
  });
};

const prepareInput = (input) => {
  const type = inputValidationType(input);
  if (!type || input.readOnly) return;
  input.dataset.erpValidationType = type;
  if (type === 'phone') {
    if (input.type !== 'tel') input.type = 'tel';
    input.maxLength = 10;
    input.inputMode = 'numeric';
    input.setAttribute('pattern', '[0-9]{10}');
  } else if (type === 'gstin') {
    input.maxLength = 15;
    input.setAttribute('pattern', GSTIN_PATTERN);
    input.autocapitalize = 'characters';
  } else if (type === 'email') {
    if (input.type !== 'email') input.type = 'email';
    input.setAttribute('pattern', EMAIL_PATTERN);
  }
  showValidation(input, type, false);
};

const reportBlockedInput = (input, type) => {
  const error = validateContactField(type, input.value, { required: input.required });
  const message = error || (type === 'phone'
    ? 'Phone number must contain exactly 10 digits.'
    : type === 'gstin'
      ? 'GSTIN must contain exactly 15 alphanumeric characters.'
      : 'Please enter a valid email address.');
  input.setCustomValidity(message);
  const node = getMessageNode(input);
  node.textContent = message;
  node.hidden = false;
  input.setAttribute('aria-invalid', 'true');
};

const insertText = (input, text) => {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  input.setRangeText(text, start, end, 'end');
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
};

export const installContactValidation = () => {
  const prepareAll = (root = document) => {
    if (root.matches?.(FIELD_SELECTOR)) prepareInput(root);
    root.querySelectorAll?.(FIELD_SELECTOR).forEach(prepareInput);
  };

  const handleBeforeInput = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    prepareInput(input);
    const type = input.dataset.erpValidationType;
    if (!type || event.inputType?.startsWith('delete') || event.data == null) return;

    if (type === 'phone') {
      const selected = Math.max(0, (input.selectionEnd || 0) - (input.selectionStart || 0));
      if (!/^[0-9]+$/.test(event.data) || input.value.length - selected + event.data.length > 10) {
        event.preventDefault();
        reportBlockedInput(input, type);
      }
    } else if (type === 'email' && /\s/.test(event.data)) {
      event.preventDefault();
      reportBlockedInput(input, type);
    } else if (type === 'gstin') {
      const inserted = normalizeGSTINInput(event.data);
      const selected = Math.max(0, (input.selectionEnd || 0) - (input.selectionStart || 0));
      if (!/^[A-Z0-9]+$/.test(inserted) || input.value.length - selected + inserted.length > 15) {
        event.preventDefault();
        reportBlockedInput(input, type);
      } else if (inserted !== event.data) {
        event.preventDefault();
        insertText(input, inserted);
      }
    }
  };

  const handlePaste = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    prepareInput(input);
    const type = input.dataset.erpValidationType;
    if (!type) return;
    const pasted = event.clipboardData?.getData('text') ?? '';
    const selected = Math.max(0, (input.selectionEnd || 0) - (input.selectionStart || 0));
    if (type === 'phone') {
      if (!/^[0-9]+$/.test(pasted) || input.value.length - selected + pasted.length > 10) {
        event.preventDefault();
        reportBlockedInput(input, type);
      }
    } else if (type === 'email' && /\s/.test(pasted)) {
      event.preventDefault();
      reportBlockedInput(input, type);
    } else if (type === 'gstin') {
      const normalized = normalizeGSTINInput(pasted);
      if (!/^[A-Z0-9]+$/.test(normalized) || input.value.length - selected + normalized.length > 15) {
        event.preventDefault();
        reportBlockedInput(input, type);
      } else {
        event.preventDefault();
        insertText(input, normalized);
      }
    }
  };

  const handleInput = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    prepareInput(input);
    const type = input.dataset.erpValidationType;
    if (!type) return;
    if (type === 'gstin' && /[a-z]/.test(input.value)) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, normalizeGSTINInput(input.value));
      if (start != null && end != null) input.setSelectionRange(start, end);
    }
    showValidation(input, type, true);
  };

  const handleInvalid = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    prepareInput(input);
    const type = input.dataset.erpValidationType;
    if (type) {
      event.preventDefault();
      showValidation(input, type, true);
    }
  };

  const handleSubmit = (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const invalidInputs = validateContainer(form);
    if (invalidInputs.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      invalidInputs[0].focus();
    }
  };

  const handleActionClick = (event) => {
    const button = event.target.closest?.('button, input[type="submit"]');
    if (!button) return;
    const label = String(button.innerText || button.value || button.getAttribute('aria-label') || '').trim();
    if (/template/i.test(label)) return;
    if (!/^(save|submit|create|update|send|finish|complete)(?:\b|\s)/i.test(label)) return;
    const container = button.closest('form') || button.closest('[role="dialog"], dialog, .template-modal, .modal, .page-section');
    const invalidInputs = validateContainer(container);
    if (invalidInputs.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      invalidInputs[0].focus();
    }
  };

  const handleBlur = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const type = input.dataset.erpValidationType || inputValidationType(input);
    if (type) showValidation(input, type, true);
  };

  prepareAll();
  const observer = new MutationObserver((changes) => changes.forEach((change) => change.addedNodes.forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) prepareAll(node);
  })));
  observer.observe(document.body, { childList: true, subtree: true });
  document.addEventListener('beforeinput', handleBeforeInput, true);
  document.addEventListener('paste', handlePaste, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('blur', handleBlur, true);
  document.addEventListener('invalid', handleInvalid, true);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('click', handleActionClick, true);
  return () => {
    observer.disconnect();
    document.removeEventListener('beforeinput', handleBeforeInput, true);
    document.removeEventListener('paste', handlePaste, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('blur', handleBlur, true);
    document.removeEventListener('invalid', handleInvalid, true);
    document.removeEventListener('submit', handleSubmit, true);
    document.removeEventListener('click', handleActionClick, true);
  };
};
