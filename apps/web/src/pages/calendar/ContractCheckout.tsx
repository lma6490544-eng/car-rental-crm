import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { MouseEvent, ReactNode, Ref } from 'react';
import { LoadingOutlined, RightOutlined, SwapOutlined } from '@ant-design/icons';
import { Badge, Button, Collapse, ConfigProvider, Modal, Space, Steps, Tooltip } from 'antd';
import type { StepsProps } from 'antd';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth';
import type { BookingDetail, BookingFinance, BookingOptions } from '../../contracts';
import type { Customer } from '../../domain/catalog';
import { personalFullName, suggestPersonalName } from '../../features/customers/customer-fields';
import { CheckoutDriver } from '../../features/documents/CheckoutDriver';
import { contractGeneratingLabel, ContractEditor } from '../../features/documents/ContractEditor';
import type {
  BookingDocuments,
  InspectionWork,
  PhotoKind,
} from '../../features/documents/document-types';
import { actGeneratingLabel, InspectionEditor } from '../../features/documents/InspectionEditor';
import { CommandFeedback } from '../../features/documents/PrivateFileControls';
import { useDocumentCommand } from '../../features/documents/useDocumentCommand';
import { usePolling } from '../../shared/hooks';
import { PollNotice } from '../../shared/PollNotice';
import { rub } from '../../shared/formatters';
import BookingForm, { type BookingTermsForm } from '../booking-form/BookingForm';
import { local } from './dates';
import { CheckoutPayment, remainingDepositRub } from './CheckoutPayment';
import { RentPaymentTag } from './RentPaymentStatus';
import { RentalReturn } from './RentalReturn';
import type { RentalReturnData } from './RentalReturn';
import { VehicleAssignmentDialog } from './VehicleAssignmentDialog';
import type { VehicleMove } from './VehicleAssignmentDialog';
import '../../features/documents/documents.css';

const issueSections = ['driver', 'contract', 'act', 'payment'] as const;
const returnSections = [
  { key: 'return-act', title: 'Акт приёмки' },
  { key: 'return-vehicle', title: 'Сдача автомобиля' },
] as const;
const checkoutSections = [...issueSections, ...returnSections.map(({ key }) => key)] as const;
type IssueSection = (typeof issueSections)[number];
type CheckoutStep = (typeof checkoutSections)[number];
type CheckoutDocument = 'contract' | 'act';
type CheckoutDestination = {
  section?: CheckoutStep;
  target?: 'start' | 'feedback' | 'contract-document' | 'act-document' | 'rent' | 'deposit';
};
type CheckoutReveal = CheckoutDestination & { highlight?: boolean };
type CheckoutNavigation = {
  step?: CheckoutStep;
  expanded: boolean;
  reveal?: CheckoutReveal;
  completed: Record<IssueSection, boolean>;
  trackingProgress: boolean;
  issued: boolean;
  issueFocus?: 'pending' | 'ready';
};
type IssueBlocker = CheckoutDestination & { message: string; amount?: string };
const sectionLabel = (title: string, status?: ReactNode, details?: ReactNode) => (
  <>
    <RightOutlined className="checkout-section-arrow" aria-hidden="true" />
    <span>
      <span className="checkout-heading-line">
        <strong>{title}</strong>
        {details}
      </span>
      {status && <span className="checkout-section-status">{status}</span>}
    </span>
  </>
);

function inspectionWorkDescription(work: InspectionWork) {
  const operator = work.operatorName.trim().split(/\s+/).slice(0, 2).join(' ');
  return 'Осмотр заполняется. Ответственный: ' + operator;
}

function rentalPeriod(start: string, end: string) {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: local(start).slice(0, 4) !== local(end).slice(0, 4) ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${date.format(new Date(start))} — ${date.format(new Date(end))}`;
}
export type CheckoutExitGuard = { requestClose: () => void; refreshVehicle: () => void };

export function ContractCheckout({
  id,
  autoStart,
  initialStep,
  ref,
  onClose,
  onLock,
  onChanged,
  onMove,
}: {
  id: number;
  autoStart: boolean;
  initialStep?: 'driver' | 'return-act';
  ref: Ref<CheckoutExitGuard>;
  onClose: () => void;
  onLock: (locked: boolean) => void;
  onChanged: () => void;
  onMove: (request: VehicleMove) => void;
}) {
  const path = '/bookings/' + id;
  const { user } = useAuth();
  const openedDocumentKey = `checkout.opened.${user?.id}.${id}.`;
  const [openedDocuments, setOpenedDocuments] = useState<Partial<Record<CheckoutDocument, number>>>(
    {},
  );
  useEffect(() => {
    try {
      for (const kind of ['contract', 'act']) {
        const sessionKey = openedDocumentKey + kind;
        const version = sessionStorage.getItem(sessionKey);
        if (version !== null) {
          localStorage.setItem(`${sessionKey}.${version}`, '1');
          sessionStorage.removeItem(sessionKey);
        }
      }
    } catch {
      // The old mark remains in the session if browser storage cannot be written.
    }
  }, [openedDocumentKey]);
  const navigate = useNavigate();
  const docs = usePolling<BookingDocuments>(path + '/documents');
  const booking = usePolling<BookingDetail>(path);
  const finance = usePolling<BookingFinance>(path + '/finance');
  const data = docs.data;
  const b = booking.data;
  const customerId = data?.booking.customerId;
  const customer = usePolling<Customer>(customerId ? '/customers/' + customerId : undefined);
  const [contractEditing, setContractEditing] = useState(false);
  const [contractActions, setContractActions] = useState<HTMLDivElement | null>(null);
  const [actActions, setActActions] = useState<HTMLDivElement | null>(null);
  const [returnActActions, setReturnActActions] = useState<HTMLDivElement | null>(null);
  const [returnSettlement, setReturnSettlement] = useState<HTMLDivElement | null>(null);
  const [returnSettlementActions, setReturnSettlementActions] = useState<HTMLDivElement | null>(
    null,
  );
  const [inspectionKind, setInspectionKind] = useState<PhotoKind>('pickup');
  const [inspectionEditing, setInspectionEditing] = useState(false);
  const [driverDirty, setDriverDirty] = useState(false);
  const checkoutRef = useRef<HTMLDivElement>(null);
  const sectionsRef = useRef<HTMLDivElement>(null);
  const issueButtonRef = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState<'close' | 'issue' | 'stop'>();
  const exitAfterDiscard = useRef<() => void>(undefined);
  const draftToReveal = useRef<CheckoutStep>(undefined);
  const [paymentDirty, setPaymentDirty] = useState(false);
  const [contractDirty, setContractDirty] = useState(false);
  const [inspectionDirty, setInspectionDirty] = useState(false);
  const [returnBusy, setReturnBusy] = useState(false);
  const [returnEditing, setReturnEditing] = useState(false);
  const [returnDirty, setReturnDirty] = useState(false);
  const [settlementDirty, setSettlementDirty] = useState(false);
  const [pickingVehicle, setPickingVehicle] = useState(false);
  const fleet = usePolling<BookingOptions>(pickingVehicle ? '/booking-options' : undefined);
  const [termsDraftBase, setTermsDraftBase] = useState<BookingDetail>();
  const termsForm = useRef<BookingTermsForm>(null);
  const [termsReady, setTermsReady] = useState(false);
  const [termsReset, setTermsReset] = useState(0);
  const [savedTermsVersion, setSavedTermsVersion] = useState<number>();
  const issued = !!data?.checkout?.issuedAt;
  const rentalReturn = usePolling<RentalReturnData>(issued ? path + '/return' : undefined);
  async function refresh() {
    await Promise.all([
      docs.reload(),
      booking.reload(),
      finance.reload(),
      ...(issued ? [rentalReturn.reload()] : []),
      ...(customerId ? [customer.reload()] : []),
    ]);
    onChanged();
  }
  const command = useDocumentCommand(refresh);
  const locked = command.locked || returnBusy;
  useEffect(() => {
    if (!locked) return;
    onLock(true);
    return () => onLock(false);
  }, [locked, onLock]);
  const checkout = data?.checkout;
  const canStart =
    !!data && !checkout && data.booking.status === 'confirmed' && data.booking.vehicleId !== null;
  function start() {
    if (canStart)
      command.run('checkout.start', path + '/checkout/start', {
        body: { expectedBookingVersion: data.booking.version },
      });
  }
  const checkedInitialState = useRef(false);
  const startOnOpen = useEffectEvent(start);
  useEffect(() => {
    if (!data || checkedInitialState.current) return;
    checkedInitialState.current = true;
    if (autoStart && canStart) startOnOpen();
  }, [autoStart, canStart, data]);
  const summary = finance.data?.summary;
  const invoicePayment = finance.data?.invoicePayment;
  const terms = b?.terms[0]?.snapshot;
  const waitingForTerms =
    savedTermsVersion !== undefined &&
    (!b || !data || b.version < savedTermsVersion || b.version !== data.booking.version);
  const termsSource = termsDraftBase ?? b;
  const termsDirty = !!termsDraftBase;
  const disabled = locked || termsDirty || waitingForTerms;
  const rentalCompleted =
    data?.booking.status === 'completed' || data?.booking.status === 'completed_early';
  const returnInspectionSaved = !!rentalReturn.data?.history.length;
  const returnWork = rentalReturn.data?.inspectionWork;
  const returnWorkLabel = returnWork ? inspectionWorkDescription(returnWork) : undefined;
  let returnActHint: string | undefined;
  if (returnWork)
    returnActHint = returnWork.operatorId === user?.id ? 'Завершите осмотр' : 'Дождитесь осмотра';
  else if (returnEditing) returnActHint = 'Исправление приёмки';
  else if (returnInspectionSaved) returnActHint = 'Осмотр сохранён';
  else if (rentalReturn.loading) returnActHint = 'Загружаем приёмку…';
  else if (rentalReturn.error) returnActHint = 'Обновите данные приёмки';
  else returnActHint = 'Заполните осмотр';
  let returnVehicleHint: string | undefined;
  if (!returnInspectionSaved) returnVehicleHint = 'Нужен осмотр';
  else if (returnWork) returnVehicleHint = 'Идёт осмотр';
  else if (!rentalCompleted) returnVehicleHint = 'Подтвердите приёмку';
  let returnActStepStatus: NonNullable<StepsProps['items']>[number]['status'] = 'wait';
  if (returnWork || returnEditing) returnActStepStatus = 'process';
  else if (returnInspectionSaved) returnActStepStatus = 'finish';
  const savedCustomer = customer.data;
  const customerSectionTitle = savedCustomer?.type === 'company' ? 'Организация' : 'Водитель';
  let customerName = savedCustomer?.displayName || b?.customer_name;
  if (savedCustomer?.type === 'individual') {
    const details = savedCustomer.details;
    if (details.lastName?.trim() && details.firstName?.trim())
      customerName = personalFullName(details);
  }
  const suggestedNames = customer.data && !issued ? suggestPersonalName(customer.data) : {};
  const driverReady =
    !!customer.data?.documentReadiness.ready &&
    Object.keys(suggestedNames).length === 0 &&
    !driverDirty;
  let driverHint: string | undefined;
  if (customer.data && !issued && !driverReady) {
    driverHint = driverDirty ? 'Сохраните данные' : 'Заполните данные';
  }
  const currentContract = data?.contracts.find(
    (c) =>
      c.bookingVersion === data.booking.version &&
      c.customerVersion === data.customerVersion &&
      c.status === 'ready',
  );
  const latestContract = data?.contracts[0];
  const contractGenerating =
    !issued &&
    (command.activeCommand === 'bookings.terms' ||
      command.activeCommand === 'contracts.create' ||
      command.activeCommand === 'contracts.retry' ||
      (latestContract?.status === 'pending' &&
        latestContract.bookingVersion === data?.booking.version &&
        latestContract.customerVersion === data?.customerVersion));
  const inspection = data?.inspections.find((version) => version.kind === inspectionKind);
  const inspectionSaved = !!inspection && inspection.vehicleId === data?.booking.vehicleId;
  const inspectionWork = data?.inspectionWork.find(
    (work) => work.kind === inspectionKind && (!issued || work.kind === 'pickup'),
  );
  const inspectionWorkLabel = inspectionWork
    ? inspectionWorkDescription(inspectionWork)
    : undefined;
  const pickupWork = data?.inspectionWork.some((work) => work.kind === 'pickup');
  const latestAct = data?.acts.find(
    (act) =>
      act.bookingVersion === data.booking.version &&
      act.inspectionRevisionId === inspection?.id &&
      (issued || act.matchesCustomer),
  );
  const currentAct = inspectionSaved && latestAct?.status === 'ready' ? latestAct : undefined;
  const actGenerating =
    inspectionSaved &&
    !inspectionWork &&
    !currentAct &&
    (latestAct?.status === 'pending' ||
      command.activeCommand === 'acts.generate' ||
      command.activeCommand === 'acts.retry');
  const documentGenerating = contractGenerating || actGenerating;
  const contractSigned = !!checkout?.currentContractSigned;
  const actSigned = !!checkout?.currentActSigned;
  function documentWasOpened(kind: CheckoutDocument, versionId: number | undefined) {
    if (versionId === undefined) return false;
    if (openedDocuments[kind] === versionId) return true;
    const sessionKey = openedDocumentKey + kind;
    try {
      return (
        sessionStorage.getItem(sessionKey) === String(versionId) ||
        localStorage.getItem(`${sessionKey}.${versionId}`) === '1'
      );
    } catch {
      return false;
    }
  }
  const contractOpened = documentWasOpened('contract', currentContract?.id);
  const actOpened = documentWasOpened('act', currentAct ? currentAct.id : undefined);
  function markDocumentOpened(kind: CheckoutDocument, versionId: number) {
    setOpenedDocuments((previous) => ({ ...previous, [kind]: versionId }));
    try {
      localStorage.setItem(`${openedDocumentKey}${kind}.${versionId}`, '1');
    } catch {
      // Opening the document still updates the step when browser storage is unavailable.
    }
  }
  const printContractHint = 'Распечатайте договор';
  const printActHint = 'Распечатайте акт';
  let contractStatus: string | undefined = 'Сформируйте договор';
  if (contractGenerating) contractStatus = contractGeneratingLabel;
  else if (contractSigned) contractStatus = 'Подписан';
  else if (currentContract) contractStatus = contractOpened ? undefined : printContractHint;
  let actStatus: string | undefined = data?.vehicle ? 'Проведите осмотр' : 'Назначьте автомобиль';
  let actInstruction: string | undefined;
  if (inspectionWork) {
    actStatus = inspectionWork.operatorId === user?.id ? 'Завершите осмотр' : 'Дождитесь осмотра';
  } else if (actGenerating) actStatus = actGeneratingLabel;
  else if (actSigned) actStatus = 'Подписан';
  else if (currentAct) actStatus = actOpened ? undefined : printActHint;
  else if (inspectionSaved) {
    actStatus = 'Сформируйте акт';
    actInstruction = 'Оператор заполнил данные. Сформируйте акт и дайте его клиенту на подпись.';
  }
  const moneyReceived = !!checkout?.rentReceived && !!checkout?.depositReceived;
  let paymentHint: string | undefined;
  let paymentStepHint: string | undefined;
  if (checkout && !issued && !moneyReceived) {
    if (checkout.rentReceived) paymentHint = 'Подтвердите залог';
    else if (checkout.depositReceived) paymentHint = 'Подтвердите оплату';
    else {
      paymentHint = 'Подтвердите оплату и залог';
      paymentStepHint = 'Примите оплату и залог';
    }
  }
  const paymentComplete = issued || moneyReceived;
  const contractComplete = issued || contractSigned;
  const actComplete = issued || actSigned;
  const completed: Record<IssueSection, boolean> = {
    driver: driverReady,
    contract: contractComplete || contractOpened,
    act: actComplete || (!pickupWork && actOpened),
    payment: paymentComplete,
  };
  const visibleReturnSections = issued ? returnSections : [];
  const drafts: { section: CheckoutStep; title: string; dirty: boolean }[] = [
    { section: 'driver', title: customerSectionTitle, dirty: driverDirty },
    { section: 'contract', title: 'Договор', dirty: contractDirty || termsDirty },
    { section: 'act', title: 'Акт', dirty: inspectionDirty },
    { section: 'payment', title: 'Оплата', dirty: paymentDirty },
    { section: 'return-act', title: 'Акт приёмки', dirty: returnDirty },
    { section: 'return-vehicle', title: 'Сдача автомобиля', dirty: settlementDirty },
  ];
  const unsaved = drafts.filter((draft) => draft.dirty);
  const issueBlockers: IssueBlocker[] = [];
  if (!checkout)
    issueBlockers.push({
      message: 'Начните оформление договора.',
      section: 'driver',
      target: 'start',
    });
  if (!currentContract)
    issueBlockers.push({
      message: contractGenerating ? contractGeneratingLabel : 'Сформируйте актуальный договор.',
      section: 'contract',
      target: 'contract-document',
    });
  if (pickupWork || (!currentAct && !inspectionSaved)) {
    issueBlockers.push({
      message: 'Завершите осмотр автомобиля.',
      section: 'act',
      target: 'act-document',
    });
  } else if (!currentAct) {
    issueBlockers.push({
      message: actGenerating ? actGeneratingLabel : 'Сформируйте актуальный акт.',
      section: 'act',
      target: 'act-document',
    });
  }
  if (checkout && currentContract) {
    if (!checkout.rentReceived)
      issueBlockers.push({
        message: 'Подтвердите оплату аренды.',
        amount: summary?.debtRub,
        section: 'payment',
        target: 'rent',
      });
    if (!checkout.depositReceived) {
      const amount =
        summary &&
        remainingDepositRub(
          checkout.requiredDepositRub ?? summary.suggestedDepositRub,
          summary.depositRub,
        );
      issueBlockers.push({
        message: 'Подтвердите получение залога.',
        amount,
        section: 'payment',
        target: 'deposit',
      });
    }
  }
  for (const { section, title } of unsaved) {
    issueBlockers.push({ message: `Сохраните изменения в разделе «${title}».`, section });
  }
  if (contractEditing && !contractDirty && !termsDirty) {
    issueBlockers.push({ message: 'Завершите редактирование договора.', section: 'contract' });
  }
  if (inspectionEditing && !inspectionDirty && !pickupWork) {
    issueBlockers.push({ message: 'Завершите редактирование осмотра.', section: 'act' });
  }
  if (waitingForTerms)
    issueBlockers.push({ message: 'Дождитесь обновления условий аренды.', section: 'contract' });
  if (command.pending)
    issueBlockers.push({
      message: 'Проверьте результат предыдущего действия.',
      target: 'feedback',
    });
  else if (command.locked && !documentGenerating)
    issueBlockers.push({ message: 'Дождитесь завершения текущего действия.', target: 'feedback' });
  const canIssue = !command.locked && issueBlockers.length === 0;
  const trackingProgress = !!checkout && !!savedCustomer && !issued;
  const [navigation, setNavigation] = useState<CheckoutNavigation>(() => ({
    step: initialStep,
    expanded: initialStep !== undefined,
    completed,
    trackingProgress,
    issued,
  }));
  const progressChanged = issueSections.some(
    (section) => completed[section] !== navigation.completed[section],
  );
  const justCompleted =
    trackingProgress && navigation.trackingProgress
      ? issueSections.find((section) => completed[section] && !navigation.completed[section])
      : undefined;
  let { step, expanded, issueFocus } = navigation;
  if (issued && !navigation.issued) {
    expanded = initialStep !== undefined;
    issueFocus = undefined;
  } else if (justCompleted) {
    const remaining = issueSections.filter((section) => !completed[section]);
    const completedIndex = issueSections.indexOf(justCompleted);
    step =
      remaining.find((section) => issueSections.indexOf(section) > completedIndex) ?? remaining[0];
    expanded = step !== undefined;
    issueFocus = expanded ? undefined : 'pending';
  } else if (!trackingProgress || progressChanged) {
    issueFocus = undefined;
  }
  if (issueFocus === 'pending' && canIssue) issueFocus = 'ready';
  if (
    progressChanged ||
    issued !== navigation.issued ||
    trackingProgress !== navigation.trackingProgress ||
    issueFocus !== navigation.issueFocus
  ) {
    setNavigation({
      ...navigation,
      step,
      expanded,
      issueFocus,
      completed,
      trackingProgress,
      issued,
    });
  }

  const revealRequest = navigation.reveal;
  useLayoutEffect(() => {
    if (!revealRequest) return;
    const { section, target, highlight } = revealRequest;
    const header =
      section &&
      sectionsRef.current?.querySelector<HTMLElement>(
        `.checkout-section-${section} > .ant-collapse-header > .ant-collapse-header-text`,
      );
    const destination =
      target &&
      checkoutRef.current?.querySelector<HTMLElement>(`[data-checkout-target="${target}"]`);
    const element = destination && destination.childNodes.length ? destination : header;
    if (!element) return;
    let cancelled = false;
    function showDestination() {
      if (!element || cancelled) return;
      element.scrollIntoView({ block: 'start', inline: 'nearest' });
      element.focus({ preventScroll: true });
      if (highlight) element.setAttribute('data-checkout-highlight', '');
    }
    if (!highlight || !section) {
      showDestination();
    }
    let frame: number | undefined;
    if (highlight && section) {
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const contents = sectionsRef.current?.querySelectorAll(
            '.checkout-collapse > .checkout-section > .ant-collapse-content',
          );
          const animations = Array.from(contents ?? []).flatMap((content) =>
            content.getAnimations(),
          );
          void Promise.allSettled(animations.map((animation) => animation.finished)).then(
            showDestination,
          );
        });
      });
    }
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      element.removeAttribute('data-checkout-highlight');
    };
  }, [revealRequest]);
  useLayoutEffect(() => {
    if (issueFocus !== 'ready') return;
    const button = issueButtonRef.current;
    button?.focus();
  }, [issueFocus]);

  const visibleSections: readonly CheckoutStep[] = issued ? checkoutSections : issueSections;
  const currentStep = step === undefined ? -1 : visibleSections.indexOf(step);

  function revealDestination(destination: CheckoutReveal) {
    setNavigation((previous) => ({
      ...previous,
      step: destination.section ?? previous.step,
      expanded: destination.section !== undefined || previous.expanded,
      reveal: destination,
      issueFocus: undefined,
    }));
  }
  function reveal(section: CheckoutStep) {
    if (section === 'return-vehicle' && !returnInspectionSaved) return;
    revealDestination({ section });
  }
  function revealReturnAct() {
    reveal('return-act');
  }
  function revealReturnVehicle() {
    reveal('return-vehicle');
  }
  function revealStep(index: number) {
    const section = visibleSections[index];
    if (section) reveal(section);
  }
  function handleSectionChange(keys: string[]) {
    const section = visibleSections.find((candidate) => candidate === keys[0]);
    if (section === 'return-vehicle' && !returnInspectionSaved) return;
    setNavigation((previous) => ({
      ...previous,
      step: section ?? previous.step,
      expanded: section !== undefined,
      issueFocus: undefined,
    }));
  }
  const issueChecklist: IssueBlocker[] = [];
  if (contractGenerating && currentContract) {
    issueChecklist.push({
      message: contractGeneratingLabel,
      section: 'contract',
      target: 'contract-document',
    });
  } else if (contractStatus === printContractHint) {
    issueChecklist.push({
      message: printContractHint,
      section: 'contract',
      target: 'contract-document',
    });
  }
  if (actStatus === printActHint) {
    issueChecklist.push({ message: printActHint, section: 'act', target: 'act-document' });
  }
  issueChecklist.push(...issueBlockers);
  const issueBlockersId = useId();
  function requestExit(exit: () => void) {
    if (locked) return;
    if (unsaved.length) {
      exitAfterDiscard.current = exit;
      setConfirming('close');
    } else {
      exit();
    }
  }
  function handleCardLink(event: MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey)
      return;
    if (!locked && !unsaved.length) return;
    event.preventDefault();
    const { pathname, search, hash } = event.currentTarget;
    requestExit(() => void navigate(pathname + search + hash));
  }
  useImperativeHandle(ref, () => ({
    refreshVehicle: () => void refresh(),
    requestClose() {
      requestExit(onClose);
    },
  }));
  function stopCheckout(confirmed: boolean) {
    if (!data || !checkout || issued || checkout.hasMoney || command.locked) return;
    setConfirming(undefined);
    command.run(
      'checkout.stop',
      path + '/checkout/stop',
      {
        body: {
          expectedBookingVersion: data.booking.version,
          expectedStartedAt: checkout.startedAt,
          confirmed,
        },
      },
      onClose,
      (failure) => {
        if (failure.code !== 'CHECKOUT_STOP_CONFIRMATION_REQUIRED') return false;
        setConfirming('stop');
        return true;
      },
    );
  }
  function requestStopCheckout() {
    if (unsaved.length || checkout?.hasChanges || pickupWork) {
      setConfirming('stop');
      return;
    }
    stopCheckout(false);
  }
  function issue() {
    if (!data || command.locked) return;
    if (unsaved.length) {
      setConfirming('issue');
      return;
    }
    if (canIssue && currentContract && currentAct)
      command.run('checkout.issue', path + '/checkout/issue', {
        body: {
          expectedBookingVersion: data.booking.version,
          contractVersionId: currentContract.id,
          actVersionId: currentAct.id,
        },
      });
  }
  const updateTermsDirty = useCallback(
    (dirty: boolean) => {
      setTermsDraftBase((previous) => (dirty ? (previous ?? b) : undefined));
    },
    [b],
  );
  function resetTerms() {
    updateTermsDirty(false);
    setTermsReset((value) => value + 1);
  }
  function termsSaved(version: number) {
    setSavedTermsVersion(version);
    resetTerms();
  }
  function prepareTerms() {
    const body = termsForm.current?.buildBody();
    if (!body) return;
    return {
      body,
      onSaved: termsSaved,
      onAvailabilityChanged: () => termsForm.current?.refreshAvailability(),
    };
  }
  function discardAndClose() {
    const exit = exitAfterDiscard.current;
    exitAfterDiscard.current = undefined;
    setConfirming(undefined);
    exit?.();
  }
  function cancelConfirmation() {
    exitAfterDiscard.current = undefined;
    setConfirming(undefined);
  }
  function goToDraft() {
    draftToReveal.current = termsDirty ? 'contract' : unsaved[0]?.section;
    cancelConfirmation();
  }
  function revealDraftAfterClose() {
    const section = draftToReveal.current;
    draftToReveal.current = undefined;
    if (section) revealStep(visibleSections.indexOf(section));
  }
  const editingContract = contractEditing && !!currentContract && !contractGenerating;
  const contractDetails = editingContract ? (
    <Badge
      className="checkout-contract-edit-indicator"
      status="warning"
      text="Редактирование договора"
    />
  ) : (
    b &&
    terms &&
    !waitingForTerms && (
      <>
        <span className="checkout-heading-badge">{rentalPeriod(b.start_at, b.end_at)}</span>
        <span className="checkout-heading-badge">{rub(terms.finalTotalRub)}</span>
      </>
    )
  );
  const vehicle = data?.vehicle;
  const canReplaceVehicle = !!b && b.status === 'confirmed' && !issued && !!checkout;
  function openVehiclePicker() {
    setPickingVehicle(true);
    void booking.reload();
  }
  const targetId =
    termsSource?.target_vehicle_id ??
    termsSource?.target_model_id ??
    termsSource?.target_brand_id ??
    termsSource?.target_group_id;
  const renderTermsEditor = (deposit?: ReactNode) => {
    if (!terms || !termsSource) return deposit;
    return (
      <>
        <div className="checkout-terms-heading">
          <h3>Условия аренды</h3>
        </div>
        {waitingForTerms ? (
          <>
            <span role="status">Обновляем расчёт…</span>
            {deposit}
          </>
        ) : (
          <BookingForm
            key={termsSource.version + ':' + termsReset}
            mode="terms"
            termsRef={termsForm}
            initial={{
              bookingId: id,
              vehicleId: termsSource.vehicle_id ?? undefined,
              calculation: termsSource.terms[0]?.snapshot,
              version: termsSource.version,
              target: termsSource.target_type + ':' + targetId,
              start: local(termsSource.start_at),
            }}
            disabled={command.locked || issued || !checkout}
            onTermsDirtyChange={updateTermsDirty}
            onTermsReadyChange={setTermsReady}
            contractDeposit={deposit}
          />
        )}
      </>
    );
  };
  return (
    <Space ref={checkoutRef} direction="vertical" className="document-stack" size="middle">
      <PollNotice {...docs} />
      <PollNotice {...booking} />
      <PollNotice {...finance} />
      {(command.error || command.pending || (command.busy && !documentGenerating)) && (
        <div data-checkout-target="feedback" tabIndex={-1}>
          <ConfigProvider componentDisabled={false}>
            <CommandFeedback command={command} />
          </ConfigProvider>
          {command.busy && !command.pending && !documentGenerating && (
            <span role="status">Выполняем действие…</span>
          )}
        </div>
      )}
      {canStart && (
        <Button data-checkout-target="start" disabled={disabled} onClick={start}>
          Начать оформление
        </Button>
      )}
      {data && (
        <div className="checkout-layout">
          <Steps
            className="checkout-steps"
            direction="vertical"
            size="small"
            responsive={false}
            current={currentStep}
            onChange={revealStep}
            items={(
              [
                {
                  title: customerSectionTitle,
                  description: driverHint,
                  status: driverReady ? 'finish' : 'wait',
                },
                {
                  title: 'Договор',
                  icon: contractGenerating && (
                    <span role="status" aria-label={contractGeneratingLabel}>
                      <LoadingOutlined aria-hidden="true" />
                    </span>
                  ),
                  description: contractStatus,
                  status: contractGenerating
                    ? 'process'
                    : contractComplete || contractOpened
                      ? 'finish'
                      : currentContract
                        ? 'process'
                        : 'wait',
                },
                {
                  title: 'Акт',
                  icon: (inspectionWork || actGenerating) && (
                    <span
                      role="status"
                      aria-label={actGenerating ? actGeneratingLabel : 'Осмотр заполняется'}
                    >
                      <LoadingOutlined aria-hidden="true" />
                    </span>
                  ),
                  description: actStatus,
                  status: inspectionWork
                    ? 'process'
                    : actComplete || actOpened
                      ? 'finish'
                      : inspectionSaved
                        ? 'process'
                        : 'wait',
                },
                {
                  title: 'Оплата',
                  description: paymentStepHint ?? paymentHint,
                  status: paymentComplete ? 'finish' : checkout?.hasMoney ? 'process' : 'wait',
                },
                ...visibleReturnSections.map<NonNullable<StepsProps['items']>[number]>(
                  ({ key, title }) => ({
                    title,
                    description: key === 'return-act' ? returnActHint : returnVehicleHint,
                    icon: key === 'return-act' && returnWork && (
                      <span role="status" aria-label={returnWorkLabel}>
                        <LoadingOutlined aria-hidden="true" />
                      </span>
                    ),
                    status:
                      key === 'return-act'
                        ? returnActStepStatus
                        : rentalCompleted
                          ? 'finish'
                          : 'wait',
                    disabled: key === 'return-vehicle' && !returnInspectionSaved,
                  }),
                ),
              ] satisfies NonNullable<StepsProps['items']>
            ).map((item: NonNullable<StepsProps['items']>[number], index) => ({
              ...item,
              description: item.description && (
                <span className="checkout-step-hint">{item.description}</span>
              ),
              'aria-current': index === currentStep ? 'step' : undefined,
              'aria-disabled': item.disabled || undefined,
              onClick: () => {
                if (index === currentStep) revealStep(index);
              },
            }))}
          />
          <div
            ref={sectionsRef}
            className="checkout-sections"
            onKeyDown={(event) => {
              const target = event.target;
              if (
                event.key === ' ' &&
                target instanceof HTMLElement &&
                target.matches(
                  '.checkout-section > .ant-collapse-header > .ant-collapse-header-text',
                )
              ) {
                event.preventDefault();
                target.click();
              }
            }}
          >
            <Collapse
              accordion
              className="checkout-collapse"
              collapsible="header"
              activeKey={expanded && step && currentStep >= 0 ? step : []}
              onChange={handleSectionChange}
              items={[
                {
                  key: 'driver',
                  label: sectionLabel(
                    customerSectionTitle,
                    driverHint && <Badge status="default" text={driverHint} />,
                  ),
                  extra: customerName && customerId && (
                    <Link to={'/clients/' + customerId} onClick={handleCardLink}>
                      {customerName}
                    </Link>
                  ),
                  children: (
                    <>
                      {customerId && <PollNotice {...customer} />}
                      {customer.data && (
                        <CheckoutDriver
                          key={customer.data.id}
                          customer={customer.data}
                          suggestedNames={suggestedNames}
                          command={command}
                          disabled={disabled || !checkout || issued}
                          onDirty={setDriverDirty}
                        />
                      )}
                    </>
                  ),
                },
                {
                  key: 'contract',
                  label: sectionLabel(
                    'Договор',
                    !editingContract && contractStatus && (
                      <Badge
                        status={
                          contractGenerating ? 'processing' : contractSigned ? 'success' : 'default'
                        }
                        text={contractStatus}
                      />
                    ),
                    contractDetails,
                  ),
                  extra: (
                    <div
                      ref={setContractActions}
                      data-checkout-target="contract-document"
                      tabIndex={-1}
                    />
                  ),
                  children: (
                    <ContractEditor
                      id={id}
                      data={data}
                      customerSectionTitle={customerSectionTitle}
                      command={command}
                      actionsContainer={contractActions}
                      disabled={command.locked || waitingForTerms}
                      calculation={b?.version === data.booking.version ? terms : undefined}
                      renderTermsEditor={renderTermsEditor}
                      contractGenerating={contractGenerating}
                      termsChange={
                        termsDirty || waitingForTerms
                          ? {
                              ready: termsReady,
                              prepare: prepareTerms,
                              reset: termsDirty ? resetTerms : undefined,
                            }
                          : undefined
                      }
                      driverDirty={driverDirty || customer.data?.version !== data.customerVersion}
                      namesNeedReview={Object.keys(suggestedNames).length > 0}
                      suggestedDeposit={summary ? (summary.suggestedDepositRub ?? '0') : undefined}
                      onEditing={setContractEditing}
                      onDirty={setContractDirty}
                      onDocumentOpen={(versionId) => markDocumentOpened('contract', versionId)}
                    />
                  ),
                },
                {
                  key: 'act',
                  label: sectionLabel(
                    'Акт',
                    inspectionWorkLabel ? (
                      <span
                        role="status"
                        aria-label={inspectionWorkLabel}
                        title="Осмотр заполняется"
                      >
                        <Badge status="processing" text={inspectionWorkLabel} />
                      </span>
                    ) : (
                      actStatus && (
                        <Badge
                          status={actGenerating ? 'processing' : actSigned ? 'success' : 'default'}
                          text={actInstruction ?? actStatus}
                        />
                      )
                    ),
                    vehicle && (
                      <>
                        <span className="checkout-heading-badge">{vehicle.plate}</span>
                        <span className="checkout-heading-detail">
                          {vehicle.brand} {vehicle.model}
                        </span>
                      </>
                    ),
                  ),
                  extra: (
                    <div ref={setActActions} data-checkout-target="act-document" tabIndex={-1} />
                  ),
                  children: (
                    <InspectionEditor
                      id={id}
                      data={data}
                      command={command}
                      actionsContainer={actActions}
                      onVehicleClick={handleCardLink}
                      replaceVehicleAction={
                        canReplaceVehicle && (
                          <Tooltip
                            title={
                              checkout.hasMoney
                                ? 'Перед заменой автомобиля оформите возврат поступлений'
                                : data.booking.vehicleId === null
                                  ? 'Назначить автомобиль'
                                  : 'Заменить автомобиль'
                            }
                            trigger={['hover', 'focus']}
                          >
                            <span>
                              {data.booking.vehicleId === null ? (
                                <Button
                                  size="small"
                                  disabled={disabled || checkout.hasMoney}
                                  onClick={openVehiclePicker}
                                >
                                  Назначить автомобиль
                                </Button>
                              ) : (
                                <Button
                                  size="small"
                                  type="text"
                                  aria-label="Заменить автомобиль"
                                  icon={<SwapOutlined />}
                                  disabled={disabled || checkout.hasMoney}
                                  onClick={openVehiclePicker}
                                />
                              )}
                            </span>
                          </Tooltip>
                        )
                      }
                      kind={inspectionKind}
                      latestAct={latestAct}
                      actGenerating={actGenerating}
                      onKindChange={setInspectionKind}
                      work={inspectionWork}
                      onReveal={() => reveal('act')}
                      disabled={disabled || !checkout}
                      onEditing={setInspectionEditing}
                      onDirty={setInspectionDirty}
                      onDocumentOpen={(versionId) => markDocumentOpened('act', versionId)}
                    />
                  ),
                },
                {
                  key: 'payment',
                  label: sectionLabel(
                    'Оплата',
                    undefined,
                    invoicePayment ? (
                      <RentPaymentTag status={invoicePayment.status} />
                    ) : (
                      checkout && !issued && !moneyReceived && (
                        <Badge color="var(--accent)" text="Ожидает подтверждения" />
                      )
                    ),
                  ),
                  children: rentalCompleted ? (
                    <Link
                      to={'/payments?customerId=' + customerId + '&bookingId=' + id}
                      onClick={handleCardLink}
                    >
                      Платежи
                    </Link>
                  ) : (
                    summary && (
                      <CheckoutPayment
                        summary={summary}
                        invoicePayment={invoicePayment}
                        requiredDeposit={checkout?.requiredDepositRub ?? null}
                        command={command}
                        disabled={disabled || !checkout}
                        onDirty={setPaymentDirty}
                      />
                    )
                  ),
                },
                ...visibleReturnSections.map(({ key, title }) => ({
                  key,
                  label: sectionLabel(
                    title,
                    key === 'return-act' ? (
                      returnWorkLabel ? (
                        <span role="status" aria-label={returnWorkLabel} title="Осмотр заполняется">
                          <Badge status="processing" text={returnWorkLabel} />
                        </span>
                      ) : (
                        <Badge
                          status={
                            returnEditing
                              ? 'processing'
                              : returnInspectionSaved
                                ? 'success'
                                : 'default'
                          }
                          text={returnActHint}
                        />
                      )
                    ) : returnInspectionSaved && !returnWork ? (
                      <Badge
                        status={rentalCompleted ? 'success' : 'default'}
                        text={rentalCompleted ? 'Приёмка подтверждена' : 'Ждёт подтверждения'}
                      />
                    ) : undefined,
                    key === 'return-act' && vehicle && (
                      <>
                        <span className="checkout-heading-badge">{vehicle.plate}</span>
                        <span className="checkout-heading-detail">
                          {vehicle.brand} {vehicle.model}
                        </span>
                      </>
                    ),
                  ),
                  collapsible:
                    key === 'return-vehicle' && !returnInspectionSaved
                      ? ('disabled' as const)
                      : undefined,
                  extra:
                    key === 'return-act' ? (
                      <div ref={setReturnActActions} />
                    ) : (
                      <div ref={setReturnSettlementActions} />
                    ),
                  children:
                    key === 'return-act' ? (
                      <>
                        <PollNotice {...rentalReturn} />
                        {rentalReturn.data && (
                          <RentalReturn
                            key={id}
                            id={id}
                            data={rentalReturn.data}
                            reload={rentalReturn.reload}
                            command={command}
                            actionsContainer={returnActActions}
                            settlementContainer={returnSettlement}
                            settlementActionsContainer={returnSettlementActions}
                            onReveal={revealReturnAct}
                            onRevealSettlement={revealReturnVehicle}
                            onChanged={refresh}
                            onBusy={setReturnBusy}
                            onEditing={setReturnEditing}
                            onDirty={setReturnDirty}
                            onSettlementDirty={setSettlementDirty}
                            onPaymentClick={handleCardLink}
                          />
                        )}
                      </>
                    ) : (
                      <div ref={setReturnSettlement} />
                    ),
                })),
              ].map((item) => ({
                ...item,
                className: `checkout-section checkout-section-${item.key}`,
                showArrow: false,
                forceRender: true,
              }))}
            />
            {!issued && (
              <div className="checkout-issue">
                <div id={issueBlockersId} aria-live="polite">
                  {issueChecklist.length > 0 && (
                    <ul className="checkout-issue-blockers" aria-label="Для выдачи осталось">
                      {issueChecklist.map(({ message, section, target, amount }) => (
                        <li key={message}>
                          <Button
                            type="link"
                            size="small"
                            className="checkout-issue-link"
                            icon={<RightOutlined aria-hidden="true" />}
                            onClick={() => revealDestination({ section, target, highlight: true })}
                          >
                            <span>{message}</span>
                            {amount && amount !== '0' && <strong>{rub(amount)}</strong>}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <Space wrap>
                  <Button
                    ref={issueButtonRef}
                    className="checkout-primary-button"
                    type="primary"
                    aria-describedby={issueChecklist.length ? issueBlockersId : undefined}
                    disabled={command.locked || (!canIssue && !unsaved.length)}
                    onClick={issue}
                  >
                    Выдать автомобиль
                  </Button>
                  {checkout && (
                    <Tooltip
                      title={
                        checkout.hasMoney
                          ? 'Сначала оформите возврат или компенсацию проведённых денег по этой брони.'
                          : undefined
                      }
                    >
                      <span tabIndex={checkout.hasMoney ? 0 : undefined}>
                        <Button
                          danger
                          disabled={command.locked || checkout.hasMoney}
                          onClick={requestStopCheckout}
                        >
                          Прекратить оформление
                        </Button>
                      </span>
                    </Tooltip>
                  )}
                </Space>
              </div>
            )}
          </div>
        </div>
      )}
      {pickingVehicle && b && (
        <VehicleAssignmentDialog
          booking={b}
          fleet={fleet.data}
          disabled={disabled || !!checkout?.hasMoney || issued}
          onClose={() => setPickingVehicle(false)}
          onMove={onMove}
        />
      )}
      <Modal
        open={!!confirming}
        title={confirming === 'stop' ? 'Прекратить оформление?' : 'Несохранённые изменения'}
        afterClose={revealDraftAfterClose}
        onCancel={cancelConfirmation}
        footer={
          confirming === 'stop'
            ? [
                <Button key="continue" onClick={cancelConfirmation}>
                  Продолжить оформление
                </Button>,
                <Button
                  key="stop"
                  type="primary"
                  danger
                  disabled={command.locked}
                  onClick={() => stopCheckout(true)}
                >
                  Прекратить оформление
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={cancelConfirmation}>
                  Отмена
                </Button>,
                confirming === 'close' && (
                  <Button key="discard" onClick={discardAndClose}>
                    Закрыть без сохранения
                  </Button>
                ),
                <Button key="save" type="primary" onClick={goToDraft}>
                  Перейти к сохранению
                </Button>,
              ]
        }
      >
        {confirming === 'stop' && (
          <p>
            Бронь и сохранённые данные останутся в карточке. Несохранённые изменения будут потеряны.
          </p>
        )}
        {confirming === 'issue' && 'Сохраните изменения перед выдачей автомобиля.'}
        {confirming === 'close' && 'Сохраните изменения перед закрытием карточки.'}
        {unsaved.length > 0 && (
          <ul>
            {unsaved.map((draft) => (
              <li key={draft.section}>{draft.title}</li>
            ))}
          </ul>
        )}
      </Modal>
    </Space>
  );
}
