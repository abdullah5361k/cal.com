import { BookingsRepository_2024_08_13 } from "@/ee/bookings/2024-08-13/bookings.repository";
import { InputBookingsService_2024_08_13 } from "@/ee/bookings/2024-08-13/services/input.service";
import { OutputBookingsService_2024_08_13 } from "@/ee/bookings/2024-08-13/services/output.service";
import { EventTypesRepository_2024_06_14 } from "@/ee/event-types/event-types_2024_06_14/event-types.repository";
import { BillingService } from "@/modules/billing/services/billing.service";
import { PrismaReadService } from "@/modules/prisma/prisma-read.service";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { Request } from "express";

import {
  handleNewBooking,
  handleNewRecurringBooking,
  getAllUserBookings,
  handleInstantMeeting,
  handleCancelBooking,
  handleMarkNoShow,
} from "@calcom/platform-libraries";
import {
  CreateBookingInput_2024_08_13,
  CreateBookingInput,
  CreateRecurringBookingInput_2024_08_13,
  GetBookingsInput_2024_08_13,
  CreateInstantBookingInput_2024_08_13,
  CancelBookingInput_2024_08_13,
  MarkAbsentBookingInput_2024_08_13,
  BookingOutput_2024_08_13,
  RecurringBookingOutput_2024_08_13,
  GetSeatedBookingOutput_2024_08_13,
  GetRecurringSeatedBookingOutput_2024_08_13,
  RescheduleBookingInput,
  CancelBookingInput,
} from "@calcom/platform-types";
import { PrismaClient } from "@calcom/prisma";

type CreatedBooking = {
  hosts: { id: number }[];
  uid: string;
  start: string;
};

@Injectable()
export class BookingsService_2024_08_13 {
  private readonly logger = new Logger("BookingsService");
  constructor(
    private readonly inputService: InputBookingsService_2024_08_13,
    private readonly outputService: OutputBookingsService_2024_08_13,
    private readonly bookingsRepository: BookingsRepository_2024_08_13,
    private readonly eventTypesRepository: EventTypesRepository_2024_06_14,
    private readonly prismaReadService: PrismaReadService,
    private readonly billingService: BillingService
  ) {}

  async createBooking(request: Request, body: CreateBookingInput) {
    try {
      if ("instant" in body && body.instant) {
        return await this.createInstantBooking(request, body);
      }

      const eventType = await this.eventTypesRepository.getEventTypeById(body.eventTypeId);
      const isRecurring = !!eventType?.recurringEvent;
      const isSeated = !!eventType?.seatsPerTimeSlot;

      if (isRecurring && isSeated) {
        return await this.createRecurringSeatedBooking(request, body);
      }
      if (isRecurring && !isSeated) {
        return await this.createRecurringBooking(request, body);
      }
      if (isSeated) {
        return await this.createSeatedBooking(request, body);
      }

      return await this.createRegularBooking(request, body);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "no_available_users_found_error") {
          throw new BadRequestException("User either already has booking at this time or is not available");
        }
      }
      throw error;
    }
  }

  async createInstantBooking(request: Request, body: CreateInstantBookingInput_2024_08_13) {
    const bookingRequest = await this.inputService.createBookingRequest(request, body);
    const booking = await handleInstantMeeting(bookingRequest);

    const databaseBooking = await this.bookingsRepository.getByIdWithAttendeesAndUserAndEvent(
      booking.bookingId
    );
    if (!databaseBooking) {
      throw new Error(`Booking with id=${booking.bookingId} was not found in the database`);
    }

    return this.outputService.getOutputBooking(databaseBooking);
  }

  async createRecurringBooking(request: Request, body: CreateRecurringBookingInput_2024_08_13) {
    const bookingRequest = await this.inputService.createRecurringBookingRequest(request, body);
    const bookings = await handleNewRecurringBooking(bookingRequest);
    const ids = bookings.map((booking) => booking.id || 0);
    return this.outputService.getOutputRecurringBookings(ids);
  }

  async createRecurringSeatedBooking(request: Request, body: CreateRecurringBookingInput_2024_08_13) {
    const bookingRequest = await this.inputService.createRecurringBookingRequest(request, body);
    const bookings = await handleNewRecurringBooking(bookingRequest);
    return this.outputService.getOutputCreateRecurringSeatedBookings(
      bookings.map((booking) => ({ id: booking.id || 0, seatUid: booking.seatReferenceUid || "" }))
    );
  }

  async createRegularBooking(request: Request, body: CreateBookingInput_2024_08_13) {
    const bookingRequest = await this.inputService.createBookingRequest(request, body);
    const booking = await handleNewBooking(bookingRequest);

    if (!booking.uid) {
      throw new Error("Booking missing uid");
    }

    const databaseBooking = await this.bookingsRepository.getByUidWithAttendeesAndUserAndEvent(booking.uid);
    if (!databaseBooking) {
      throw new Error(`Booking with uid=${booking.uid} was not found in the database`);
    }

    return this.outputService.getOutputBooking(databaseBooking);
  }

  async createSeatedBooking(request: Request, body: CreateBookingInput_2024_08_13) {
    const bookingRequest = await this.inputService.createBookingRequest(request, body);
    const booking = await handleNewBooking(bookingRequest);

    if (!booking.uid) {
      throw new Error("Booking missing uid");
    }

    const databaseBooking = await this.bookingsRepository.getByUidWithAttendeesWithBookingSeatAndUserAndEvent(
      booking.uid
    );
    if (!databaseBooking) {
      throw new Error(`Booking with uid=${booking.uid} was not found in the database`);
    }

    return this.outputService.getOutputCreateSeatedBooking(databaseBooking, booking.seatReferenceUid || "");
  }

  async getBooking(uid: string) {
    const booking = await this.bookingsRepository.getByUidWithAttendeesWithBookingSeatAndUserAndEvent(uid);

    if (booking) {
      const isRecurring = !!booking.recurringEventId;
      const isSeated = !!booking.eventType?.seatsPerTimeSlot;

      if (isRecurring && !isSeated) {
        return this.outputService.getOutputRecurringBooking(booking);
      }
      if (isRecurring && isSeated) {
        return this.outputService.getOutputRecurringSeatedBooking(booking);
      }
      if (isSeated) {
        return this.outputService.getOutputSeatedBooking(booking);
      }
      return this.outputService.getOutputBooking(booking);
    }

    const recurringBooking = await this.bookingsRepository.getRecurringByUidWithAttendeesAndUserAndEvent(uid);
    if (!recurringBooking.length) {
      throw new NotFoundException(`Booking with uid=${uid} was not found in the database`);
    }
    const ids = recurringBooking.map((booking) => booking.id);
    const isRecurringSeated = !!recurringBooking[0].eventType?.seatsPerTimeSlot;
    if (isRecurringSeated) {
      return this.outputService.getOutputRecurringSeatedBookings(ids);
    }

    return this.outputService.getOutputRecurringBookings(ids);
  }

  async getBookings(queryParams: GetBookingsInput_2024_08_13, user: { email: string; id: number }) {
    const fetchedBookings: { bookings: { id: number }[] } = await getAllUserBookings({
      bookingListingByStatus: queryParams.status || [],
      skip: queryParams.skip ?? 0,
      // note(Lauris): we substract -1 because getAllUSerBookings child function adds +1 for some reason
      take: queryParams.take ? queryParams.take - 1 : 100,
      filters: this.inputService.transformGetBookingsFilters(queryParams),
      ctx: {
        user,
        prisma: this.prismaReadService.prisma as unknown as PrismaClient,
      },
      sort: this.inputService.transformGetBookingsSort(queryParams),
    });
    // note(Lauris): fetchedBookings don't have attendees information and responses and i don't want to add them to the handler query,
    // because its used elsewhere in code that does not need that information, so i get ids, fetch bookings and then return them formatted in same order as ids.
    const ids = fetchedBookings.bookings.map((booking) => booking.id);
    const bookings = await this.bookingsRepository.getByIdsWithAttendeesWithBookingSeatAndUserAndEvent(ids);

    const bookingMap = new Map(bookings.map((booking) => [booking.id, booking]));
    const orderedBookings = ids.map((id) => bookingMap.get(id));

    const formattedBookings: (
      | BookingOutput_2024_08_13
      | RecurringBookingOutput_2024_08_13
      | GetSeatedBookingOutput_2024_08_13
      | GetRecurringSeatedBookingOutput_2024_08_13
    )[] = [];
    for (const booking of orderedBookings) {
      if (!booking) {
        continue;
      }

      const formatted = {
        ...booking,
        eventType: booking.eventType,
        eventTypeId: booking.eventTypeId,
        startTime: new Date(booking.startTime),
        endTime: new Date(booking.endTime),
        absentHost: !!booking.noShowHost,
      };

      const isRecurring = !!formatted.recurringEventId;
      const isSeated = !!formatted.eventType?.seatsPerTimeSlot;
      if (isRecurring && !isSeated) {
        formattedBookings.push(this.outputService.getOutputRecurringBooking(formatted));
      } else if (isRecurring && isSeated) {
        formattedBookings.push(this.outputService.getOutputRecurringSeatedBooking(formatted));
      } else if (isSeated) {
        formattedBookings.push(this.outputService.getOutputSeatedBooking(formatted));
      } else {
        formattedBookings.push(this.outputService.getOutputBooking(formatted));
      }
    }

    return formattedBookings;
  }

  async rescheduleBooking(request: Request, bookingUid: string, body: RescheduleBookingInput) {
    try {
      const bookingRequest = await this.inputService.createRescheduleBookingRequest(
        request,
        bookingUid,
        body
      );
      const booking = await handleNewBooking(bookingRequest);
      if (!booking.uid) {
        throw new Error("Booking missing uid");
      }

      const databaseBooking =
        await this.bookingsRepository.getByUidWithAttendeesWithBookingSeatAndUserAndEvent(booking.uid);
      if (!databaseBooking) {
        throw new Error(`Booking with uid=${booking.uid} was not found in the database`);
      }

      const isRecurring = !!databaseBooking.recurringEventId;
      const isSeated = !!databaseBooking.eventType?.seatsPerTimeSlot;

      if (isRecurring && !isSeated) {
        return this.outputService.getOutputRecurringBooking(databaseBooking);
      }
      if (isRecurring && isSeated) {
        return this.outputService.getOutputCreateRecurringSeatedBooking(
          databaseBooking,
          booking?.seatReferenceUid || ""
        );
      }
      if (isSeated) {
        return this.outputService.getOutputCreateSeatedBooking(
          databaseBooking,
          booking.seatReferenceUid || ""
        );
      }
      return this.outputService.getOutputBooking(databaseBooking);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === "no_available_users_found_error") {
          throw new BadRequestException("User either already has booking at this time or is not available");
        }
      }
      throw error;
    }
  }

  async cancelBooking(request: Request, bookingUid: string, body: CancelBookingInput) {
    const bookingRequest = await this.inputService.createCancelBookingRequest(request, bookingUid, body);
    await handleCancelBooking(bookingRequest);
    return this.getBooking(bookingUid);
  }

  async markAbsent(bookingUid: string, bookingOwnerId: number, body: MarkAbsentBookingInput_2024_08_13) {
    const bodyTransformed = this.inputService.transformInputMarkAbsentBooking(body);

    await handleMarkNoShow({
      bookingUid,
      attendees: bodyTransformed.attendees,
      noShowHost: bodyTransformed.noShowHost,
      userId: bookingOwnerId,
    });

    const booking = await this.bookingsRepository.getByUidWithAttendeesAndUserAndEvent(bookingUid);

    if (!booking) {
      throw new Error(`Booking with uid=${bookingUid} was not found in the database`);
    }

    const isRecurring = !!booking.recurringEventId;
    if (isRecurring) {
      return this.outputService.getOutputRecurringBooking(booking);
    }
    return this.outputService.getOutputBooking(booking);
  }

  async billBookings(bookings: CreatedBooking[]) {
    for (const booking of bookings) {
      await this.billBooking(booking);
    }
  }

  async billBooking(booking: CreatedBooking) {
    const hostId = booking.hosts?.[0]?.id;
    if (!hostId) {
      this.logger.error(`Booking with uid=${booking.uid} has no host`);
      return;
    }

    await this.billingService.increaseUsageByUserId(hostId, {
      uid: booking.uid,
      startTime: new Date(booking.start),
    });
  }

  async billRescheduledBooking(newBooking: CreatedBooking, oldBookingUid: string) {
    const hostId = newBooking.hosts[0].id;
    if (!hostId) {
      this.logger.error(`Booking with uid=${newBooking.uid} has no host`);
      return;
    }

    await this.billingService.increaseUsageByUserId(hostId, {
      uid: newBooking.uid,
      startTime: new Date(newBooking.start),
      fromReschedule: oldBookingUid,
    });
  }
}
